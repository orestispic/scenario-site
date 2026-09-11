import type { AiQuotaRepository, AiReservation } from './aiQuota.ts';
import type { LocalTestRepository } from './localTestRepository.ts';
import { CommercialRepositoryError } from './types.ts';

type StoredReservation = AiReservation & {
  profileId: string;
  quotaCode: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  requestId: string;
};

function versionParts(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(current: string, minimum: string): boolean {
  const left = versionParts(current);
  const right = versionParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

/** Local-only serialized quota store used by deterministic tests and development. */
export class LocalAiQuotaRepository implements AiQuotaRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly reservations = new Map<string, StoredReservation>();

  constructor(
    private readonly commercial: LocalTestRepository,
    private readonly now: () => number = Date.now,
  ) {}

  reserve(
    input: Parameters<AiQuotaRepository['reserve']>[0],
  ): Promise<AiReservation> {
    return this.serial(async () => {
      const entitlement = await this.commercial.getEntitlements(
        input.profileId,
      );
      if (
        !entitlement ||
        !entitlement.snapshot.entitlements.some(
          (item) => item.code === input.entitlementCode && item.enabled,
        )
      )
        throw new CommercialRepositoryError(
          403,
          'ai_entitlement_missing',
          'Droit IA absent.',
        );
      if (
        !this.commercial.hasActiveDevice(
          input.profileId,
          input.deviceFingerprintHash,
          input.platform,
        )
      )
        throw new CommercialRepositoryError(
          403,
          'ai_device_inactive',
          'Appareil non activé.',
        );
      const minimum = this.commercial.minimumSupportedVersion(input.platform);
      if (!versionParts(input.clientVersion))
        throw new CommercialRepositoryError(
          400,
          'invalid_client_version',
          'Version client invalide.',
        );
      if (minimum && !versionAtLeast(input.clientVersion, minimum))
        throw new CommercialRepositoryError(
          426,
          'client_update_required',
          'Mise à jour requise.',
        );

      const key = `${input.profileId}:${input.idempotencyKeyHash}`;
      const existing = this.reservations.get(key);
      if (existing) {
        if (
          existing.requestFingerprint !== input.requestFingerprint ||
          existing.operation !== input.operation
        )
          throw new CommercialRepositoryError(
            409,
            'ai_idempotency_conflict',
            'Clé d’idempotence déjà liée à une autre demande.',
          );
        return structuredClone({ ...existing, replayed: true });
      }
      const limit = entitlement.quotaLimits[input.quotaCode];
      const period = entitlement.quotaPeriods[input.quotaCode];
      if (!Number.isSafeInteger(limit) || limit < 0 || period !== 'month')
        throw new CommercialRepositoryError(
          503,
          'ai_quota_unconfigured',
          'Quota IA non configuré.',
        );
      const date = new Date(this.now());
      const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
      const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      const used = [...this.reservations.values()].filter(
        (item) =>
          item.profileId === input.profileId &&
          item.quotaCode === input.quotaCode &&
          item.status !== 'released' &&
          Date.parse(item.periodStartsAt) === start,
      ).length;
      if (used >= limit)
        throw new CommercialRepositoryError(
          429,
          'ai_quota_exhausted',
          'Quota IA épuisé.',
        );
      const reservation: StoredReservation = {
        id: crypto.randomUUID(),
        profileId: input.profileId,
        operation: input.operation,
        quotaCode: input.quotaCode,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestFingerprint: input.requestFingerprint,
        requestId: input.requestId,
        status: 'reserved',
        replayed: false,
        snapshotId: entitlement.snapshot.id,
        configurationVersion: entitlement.snapshot.configurationVersion,
        used: used + 1,
        limit,
        periodStartsAt: new Date(start).toISOString(),
        periodEndsAt: new Date(end).toISOString(),
      };
      this.reservations.set(key, reservation);
      return structuredClone(reservation);
    });
  }

  confirm(profileId: string, reservationId: string): Promise<AiReservation> {
    return this.settle(profileId, reservationId, 'succeeded');
  }
  release(profileId: string, reservationId: string): Promise<AiReservation> {
    return this.settle(profileId, reservationId, 'released');
  }
  markUncertain(
    profileId: string,
    reservationId: string,
  ): Promise<AiReservation> {
    return this.settle(profileId, reservationId, 'uncertain');
  }
  reconcile(
    profileId: string,
    idempotencyKeyHash: string,
  ): Promise<AiReservation | null> {
    return this.serial(async () => {
      const value = this.reservations.get(`${profileId}:${idempotencyKeyHash}`);
      return value ? structuredClone({ ...value, replayed: true }) : null;
    });
  }

  private settle(
    profileId: string,
    reservationId: string,
    status: StoredReservation['status'],
  ): Promise<AiReservation> {
    return this.serial(async () => {
      const reservation = [...this.reservations.values()].find(
        (item) => item.id === reservationId && item.profileId === profileId,
      );
      if (!reservation)
        throw new CommercialRepositoryError(
          404,
          'ai_request_missing',
          'Demande IA introuvable.',
        );
      if (
        reservation.status === 'succeeded' ||
        reservation.status === 'released'
      )
        return structuredClone({ ...reservation, replayed: true });
      reservation.status = status;
      if (status === 'succeeded') {
        this.commercial.recordAiUsage({
          profileId,
          quotaCode: reservation.quotaCode,
          snapshotId: reservation.snapshotId,
          requestId: reservation.requestId,
        });
      }
      return structuredClone(reservation);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
