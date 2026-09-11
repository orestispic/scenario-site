import type {
  CloudScenario,
  CloudScenarioVersion,
  CloudSyncRequest,
  ScenarioAccessRole,
  TemporaryObjectGrant,
} from '../../lib/commercial/contracts-v6.ts';
import type { LocalTestRepository } from './localTestRepository.ts';
import type { CommercialRepository, WorkerEnvironment } from './types.ts';
import { CommercialRepositoryError } from './types.ts';

export const CLOUD_CONTENT_TYPE = 'application/vnd.scenario+json' as const;
export const CLOUD_MAX_BYTES = 4_194_304;

export interface CloudAccessContext {
  profileId: string;
  fingerprintHash: string;
  platform: 'windows' | 'macos';
  clientVersion: string;
}

export interface CloudScenarioRepository {
  authorize(context: CloudAccessContext): Promise<{ snapshotId: string }>;
  sync(input: {
    context: CloudAccessContext;
    request: Omit<CloudSyncRequest, 'content'>;
    storageKey: string;
    idempotencyHash: string;
    requestFingerprint: string;
    requestId: string;
  }): Promise<{
    scenario: CloudScenario;
    version: CloudScenarioVersion;
    replayed: boolean;
  }>;
  list(context: CloudAccessContext): Promise<CloudScenario[]>;
  versions(
    context: CloudAccessContext,
    scenarioId: string,
  ): Promise<CloudScenarioVersion[]>;
  restore(input: {
    context: CloudAccessContext;
    scenarioId: string;
    versionId: string;
    idempotencyHash: string;
    requestId: string;
  }): Promise<{
    scenario: CloudScenario;
    version: CloudScenarioVersion;
    replayed: boolean;
    storageKey: string;
  }>;
  softDelete(input: {
    context: CloudAccessContext;
    scenarioId: string;
    idempotencyHash: string;
    requestId: string;
  }): Promise<CloudScenario>;
  storageKey(
    context: CloudAccessContext,
    scenarioId: string,
    versionId: string,
  ): Promise<string>;
}

export interface ScenarioObjectStorage {
  put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
    checksum: string;
  }): Promise<void>;
  temporaryDownload(input: {
    key: string;
    profileId: string;
    scenarioId: string;
    expiresInSeconds: number;
  }): Promise<TemporaryObjectGrant>;
}

export class ScenarioConflictError extends CommercialRepositoryError {
  constructor(
    readonly scenarioId: string,
    readonly localParentVersionId: string | null,
    readonly remoteVersionId: string,
  ) {
    super(
      409,
      'scenario_parent_conflict',
      'Une version distante plus récente existe.',
    );
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value.split(/[+-]/, 1)[0].split('.').map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function hasRight(
  record: Awaited<ReturnType<CommercialRepository['getEntitlements']>>,
  code: string,
): boolean {
  return Boolean(
    record?.snapshot.entitlements.some(
      (item) => item.code === code && item.enabled,
    ),
  );
}

export class LocalCloudScenarioRepository implements CloudScenarioRepository {
  private readonly scenarios = new Map<
    string,
    CloudScenario & { ownerId: string }
  >();
  private readonly versionsByScenario = new Map<
    string,
    Array<CloudScenarioVersion & { storageKey: string }>
  >();
  private readonly memberships = new Map<
    string,
    Map<string, Exclude<ScenarioAccessRole, 'owner'>>
  >();
  private readonly idempotency = new Map<
    string,
    {
      operation: 'sync' | 'restore' | 'delete';
      fingerprint: string;
      scenarioId: string;
      versionId: string | null;
    }
  >();

  constructor(
    private readonly commercial: LocalTestRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async authorize(
    context: CloudAccessContext,
  ): Promise<{ snapshotId: string }> {
    if (
      compareVersions(
        context.clientVersion,
        this.commercial.minimumSupportedVersion(context.platform),
      ) < 0
    )
      throw new CommercialRepositoryError(
        426,
        'client_update_required',
        'Mise à jour requise.',
      );
    if (
      !this.commercial.hasActiveDevice(
        context.profileId,
        context.fingerprintHash,
        context.platform,
      )
    )
      throw new CommercialRepositoryError(
        403,
        'cloud_device_inactive',
        'Appareil non autorisé.',
      );
    const entitlements = await this.commercial.getEntitlements(
      context.profileId,
    );
    if (
      !hasRight(entitlements, 'cloud_sync') &&
      !hasRight(entitlements, 'cloud.sync')
    )
      throw new CommercialRepositoryError(
        403,
        'cloud_entitlement_missing',
        'Synchronisation cloud non autorisée.',
      );
    if (!hasRight(entitlements, 'scenario_versions'))
      throw new CommercialRepositoryError(
        403,
        'cloud_entitlement_missing',
        'Historique cloud non autorisé.',
      );
    return { snapshotId: entitlements!.snapshot.id };
  }

  async sync(input: Parameters<CloudScenarioRepository['sync']>[0]) {
    const { snapshotId } = await this.authorize(input.context);
    const replayKey = `${input.context.profileId}:${input.idempotencyHash}`;
    const previous = this.idempotency.get(replayKey);
    if (previous) {
      if (
        previous.operation !== 'sync' ||
        previous.fingerprint !== input.requestFingerprint ||
        !previous.versionId
      )
        throw new CommercialRepositoryError(
          409,
          'cloud_idempotency_conflict',
          'Clé d’idempotence déjà utilisée.',
        );
      return {
        scenario: this.publicScenario(
          this.requireScenario(previous.scenarioId),
          input.context.profileId,
        ),
        version: this.stripStorage(
          this.requireStoredVersion(previous.scenarioId, previous.versionId),
        ),
        replayed: true,
      };
    }
    const existing = this.scenarios.get(input.request.scenarioId);
    if (existing) {
      const role = this.role(existing, input.context.profileId);
      if (role !== 'owner' && role !== 'editor')
        throw new CommercialRepositoryError(
          403,
          'scenario_write_forbidden',
          'Écriture refusée.',
        );
      if (existing.deletedAt)
        throw new CommercialRepositoryError(
          409,
          'scenario_deleted',
          'Scénario supprimé.',
        );
      if (input.request.parentVersionId !== existing.currentVersionId)
        throw new ScenarioConflictError(
          existing.id,
          input.request.parentVersionId,
          existing.currentVersionId!,
        );
    } else if (input.request.parentVersionId !== null) {
      throw new CommercialRepositoryError(
        404,
        'scenario_not_found',
        'Scénario introuvable.',
      );
    }
    const createdAt = new Date(this.now()).toISOString();
    const scenario = existing ?? {
      id: input.request.scenarioId,
      title: input.request.title,
      role: 'owner' as const,
      ownerId: input.context.profileId,
      currentVersionId: null,
      deletedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const versions = this.versionsByScenario.get(scenario.id) ?? [];
    const version: CloudScenarioVersion & { storageKey: string } = {
      id: crypto.randomUUID(),
      scenarioId: scenario.id,
      authorId: input.context.profileId,
      parentVersionId: input.request.parentVersionId,
      versionNumber: versions.length + 1,
      checksum: input.request.checksum,
      sizeBytes: input.request.sizeBytes,
      contentType: CLOUD_CONTENT_TYPE,
      format: input.request.format,
      origin: input.request.origin,
      entitlementSnapshotId: snapshotId,
      requestId: input.requestId,
      createdAt,
      storageKey: input.storageKey,
    };
    versions.push(version);
    scenario.title = input.request.title;
    scenario.currentVersionId = version.id;
    scenario.updatedAt = createdAt;
    this.scenarios.set(scenario.id, scenario);
    this.versionsByScenario.set(scenario.id, versions);
    this.idempotency.set(replayKey, {
      fingerprint: input.requestFingerprint,
      operation: 'sync',
      scenarioId: scenario.id,
      versionId: version.id,
    });
    return {
      scenario: this.publicScenario(scenario, input.context.profileId),
      version: this.stripStorage(version),
      replayed: false,
    };
  }

  async list(context: CloudAccessContext): Promise<CloudScenario[]> {
    await this.authorize(context);
    return [...this.scenarios.values()]
      .filter((value) => this.role(value, context.profileId) !== null)
      .map((value) => this.publicScenario(value, context.profileId));
  }

  async versions(
    context: CloudAccessContext,
    scenarioId: string,
  ): Promise<CloudScenarioVersion[]> {
    await this.authorize(context);
    this.requireRead(scenarioId, context.profileId);
    return (this.versionsByScenario.get(scenarioId) ?? []).map((item) =>
      this.stripStorage(item),
    );
  }

  async restore(input: Parameters<CloudScenarioRepository['restore']>[0]) {
    const { snapshotId } = await this.authorize(input.context);
    const scenario = this.requireWrite(
      input.scenarioId,
      input.context.profileId,
    );
    const source = this.requireStoredVersion(input.scenarioId, input.versionId);
    const replayKey = `${input.context.profileId}:${input.idempotencyHash}`;
    const old = this.idempotency.get(replayKey);
    if (old) {
      if (
        old.operation !== 'restore' ||
        old.fingerprint !== input.versionId ||
        !old.versionId
      )
        throw new CommercialRepositoryError(
          409,
          'cloud_idempotency_conflict',
          'Clé d’idempotence déjà utilisée.',
        );
      const version = this.requireStoredVersion(
        input.scenarioId,
        old.versionId,
      );
      return {
        scenario: this.publicScenario(scenario, input.context.profileId),
        version: this.stripStorage(version),
        replayed: true,
        storageKey: version.storageKey,
      };
    }
    const versions = this.versionsByScenario.get(input.scenarioId)!;
    const createdAt = new Date(this.now()).toISOString();
    const version: CloudScenarioVersion & { storageKey: string } = {
      ...source,
      id: crypto.randomUUID(),
      authorId: input.context.profileId,
      parentVersionId: scenario.currentVersionId,
      versionNumber: versions.length + 1,
      origin: 'restore',
      entitlementSnapshotId: snapshotId,
      requestId: input.requestId,
      createdAt,
    };
    versions.push(version);
    scenario.currentVersionId = version.id;
    scenario.deletedAt = null;
    scenario.updatedAt = createdAt;
    this.idempotency.set(replayKey, {
      fingerprint: input.versionId,
      operation: 'restore',
      scenarioId: scenario.id,
      versionId: version.id,
    });
    return {
      scenario: this.publicScenario(scenario, input.context.profileId),
      version: this.stripStorage(version),
      replayed: false,
      storageKey: version.storageKey,
    };
  }

  async softDelete(
    input: Parameters<CloudScenarioRepository['softDelete']>[0],
  ): Promise<CloudScenario> {
    await this.authorize(input.context);
    const replayKey = `${input.context.profileId}:${input.idempotencyHash}`;
    const fingerprint = `${input.scenarioId}:delete`;
    const old = this.idempotency.get(replayKey);
    if (old && (old.operation !== 'delete' || old.fingerprint !== fingerprint))
      throw new CommercialRepositoryError(
        409,
        'cloud_idempotency_conflict',
        'Clé d’idempotence déjà utilisée.',
      );
    const scenario = this.requireScenario(input.scenarioId);
    if (scenario.ownerId !== input.context.profileId)
      throw new CommercialRepositoryError(
        403,
        'scenario_delete_forbidden',
        'Suppression réservée au propriétaire.',
      );
    scenario.deletedAt ??= new Date(this.now()).toISOString();
    scenario.updatedAt = scenario.deletedAt;
    this.idempotency.set(replayKey, {
      operation: 'delete',
      fingerprint,
      scenarioId: scenario.id,
      versionId: null,
    });
    return this.publicScenario(scenario, input.context.profileId);
  }

  async storageKey(
    context: CloudAccessContext,
    scenarioId: string,
    versionId: string,
  ): Promise<string> {
    await this.authorize(context);
    this.requireRead(scenarioId, context.profileId);
    return this.requireStoredVersion(scenarioId, versionId).storageKey;
  }

  addMembership(
    scenarioId: string,
    profileId: string,
    role: Exclude<ScenarioAccessRole, 'owner'>,
  ): void {
    this.requireScenario(scenarioId);
    const map = this.memberships.get(scenarioId) ?? new Map();
    map.set(profileId, role);
    this.memberships.set(scenarioId, map);
  }

  removeMembership(scenarioId: string, profileId: string): void {
    this.memberships.get(scenarioId)?.delete(profileId);
  }

  private role(
    scenario: CloudScenario & { ownerId: string },
    profileId: string,
  ): ScenarioAccessRole | null {
    return scenario.ownerId === profileId
      ? 'owner'
      : (this.memberships.get(scenario.id)?.get(profileId) ?? null);
  }
  private publicScenario(
    scenario: CloudScenario & { ownerId: string },
    profileId: string,
  ): CloudScenario {
    const { ownerId: _ownerId, ...value } = scenario;
    return { ...structuredClone(value), role: this.role(scenario, profileId)! };
  }
  private stripStorage(
    version: CloudScenarioVersion & { storageKey?: string },
  ): CloudScenarioVersion {
    const { storageKey: _storageKey, ...value } = version;
    return structuredClone(value);
  }
  private requireScenario(id: string) {
    const value = this.scenarios.get(id);
    if (!value)
      throw new CommercialRepositoryError(
        404,
        'scenario_not_found',
        'Scénario introuvable.',
      );
    return value;
  }
  private requireStoredVersion(scenarioId: string, versionId: string) {
    const value = this.versionsByScenario
      .get(scenarioId)
      ?.find((item) => item.id === versionId);
    if (!value)
      throw new CommercialRepositoryError(
        404,
        'scenario_version_not_found',
        'Version introuvable.',
      );
    return value;
  }
  private requireRead(id: string, profileId: string) {
    const value = this.requireScenario(id);
    if (!this.role(value, profileId))
      throw new CommercialRepositoryError(
        404,
        'scenario_not_found',
        'Scénario introuvable.',
      );
    return value;
  }
  private requireWrite(id: string, profileId: string) {
    const value = this.requireRead(id, profileId);
    const role = this.role(value, profileId);
    if (role !== 'owner' && role !== 'editor')
      throw new CommercialRepositoryError(
        403,
        'scenario_write_forbidden',
        'Écriture refusée.',
      );
    return value;
  }
}

export class LocalScenarioObjectStorage implements ScenarioObjectStorage {
  readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; checksum: string }
  >();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly secret = 'local-storage-grant-fixture-secret',
  ) {}
  async put(input: Parameters<ScenarioObjectStorage['put']>[0]): Promise<void> {
    if (
      input.key.startsWith('/') ||
      input.key.split('/').includes('..') ||
      input.key.length > 512
    )
      throw new CommercialRepositoryError(
        400,
        'cloud_storage_key_invalid',
        'Chemin de stockage invalide.',
      );
    const old = this.objects.get(input.key);
    if (old && old.checksum !== input.checksum)
      throw new CommercialRepositoryError(
        409,
        'object_checksum_conflict',
        'Objet déjà présent.',
      );
    this.objects.set(input.key, {
      bytes: input.bytes.slice(),
      contentType: input.contentType,
      checksum: input.checksum,
    });
  }
  async temporaryDownload(
    input: Parameters<ScenarioObjectStorage['temporaryDownload']>[0],
  ): Promise<TemporaryObjectGrant> {
    if (!this.objects.has(input.key))
      throw new CommercialRepositoryError(
        503,
        'cloud_object_unavailable',
        'Objet indisponible.',
      );
    const expiresAt = new Date(
      this.now() + input.expiresInSeconds * 1000,
    ).toISOString();
    const payload = btoa(
      JSON.stringify({
        k: input.key,
        p: input.profileId,
        s: input.scenarioId,
        o: 'download',
        e: expiresAt,
      }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const signature = await localGrantSignature(payload, this.secret);
    const token = `${payload}.${signature}`;
    return {
      url: `https://storage.invalid/v1/download/${token}`,
      operation: 'download',
      expiresAt,
    };
  }
  async resolveTemporaryDownload(
    url: string,
    profileId: string,
    scenarioId: string,
  ): Promise<Uint8Array> {
    const token = new URL(url).pathname.split('/').pop() ?? '';
    const [payload, signature] = token.split('.');
    if (
      !payload ||
      !signature ||
      (await localGrantSignature(payload, this.secret)) !== signature
    )
      throw new CommercialRepositoryError(
        403,
        'cloud_grant_invalid',
        'URL temporaire invalide.',
      );
    let value: { k?: string; p?: string; s?: string; o?: string; e?: string };
    try {
      const base64 = payload
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payload.length / 4) * 4, '=');
      value = JSON.parse(atob(base64)) as typeof value;
    } catch {
      throw new CommercialRepositoryError(
        403,
        'cloud_grant_invalid',
        'URL temporaire invalide.',
      );
    }
    if (
      value.p !== profileId ||
      value.s !== scenarioId ||
      value.o !== 'download' ||
      !value.e ||
      Date.parse(value.e) <= this.now()
    )
      throw new CommercialRepositoryError(
        403,
        'cloud_grant_expired',
        'URL temporaire expirée.',
      );
    const object = value.k ? this.objects.get(value.k) : null;
    if (!object)
      throw new CommercialRepositoryError(
        404,
        'cloud_object_missing',
        'Objet introuvable.',
      );
    return object.bytes.slice();
  }
}

async function localGrantSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Production metadata adapter. Every mutation is delegated to a SECURITY DEFINER RPC. */
export class SupabaseCloudScenarioRepository implements CloudScenarioRepository {
  constructor(
    private readonly environment: WorkerEnvironment,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  authorize(context: CloudAccessContext) {
    return this.rpc<{ snapshotId: string }>(
      'authorize_cloud_operation',
      this.contextBody(context),
    );
  }
  sync(input: Parameters<CloudScenarioRepository['sync']>[0]) {
    return this.rpc<{
      scenario: CloudScenario;
      version: CloudScenarioVersion;
      replayed: boolean;
    }>(
      'sync_cloud_scenario',
      {
        ...this.contextBody(input.context),
        p_request: input.request,
        p_storage_key: input.storageKey,
        p_idempotency_hash: input.idempotencyHash,
        p_request_fingerprint: input.requestFingerprint,
        p_request_id: input.requestId,
      },
      {
        scenarioId: input.request.scenarioId,
        localParentVersionId: input.request.parentVersionId,
      },
    );
  }
  list(context: CloudAccessContext) {
    return this.rpc<CloudScenario[]>(
      'list_cloud_scenarios',
      this.contextBody(context),
    );
  }
  versions(context: CloudAccessContext, scenarioId: string) {
    return this.rpc<CloudScenarioVersion[]>('list_cloud_scenario_versions', {
      ...this.contextBody(context),
      p_scenario_id: scenarioId,
    });
  }
  restore(input: Parameters<CloudScenarioRepository['restore']>[0]) {
    return this.rpc<{
      scenario: CloudScenario;
      version: CloudScenarioVersion;
      replayed: boolean;
      storageKey: string;
    }>('restore_cloud_scenario_version', {
      ...this.contextBody(input.context),
      p_scenario_id: input.scenarioId,
      p_version_id: input.versionId,
      p_idempotency_hash: input.idempotencyHash,
      p_request_id: input.requestId,
    });
  }
  softDelete(input: Parameters<CloudScenarioRepository['softDelete']>[0]) {
    return this.rpc<CloudScenario>('soft_delete_cloud_scenario', {
      ...this.contextBody(input.context),
      p_scenario_id: input.scenarioId,
      p_idempotency_hash: input.idempotencyHash,
      p_request_id: input.requestId,
    });
  }
  storageKey(
    context: CloudAccessContext,
    scenarioId: string,
    versionId: string,
  ) {
    return this.rpc<string>('get_cloud_storage_key', {
      ...this.contextBody(context),
      p_scenario_id: scenarioId,
      p_version_id: versionId,
    });
  }
  private contextBody(context: CloudAccessContext) {
    return {
      p_profile_id: context.profileId,
      p_fingerprint_hash: context.fingerprintHash,
      p_platform: context.platform,
      p_client_version: context.clientVersion,
    };
  }
  private async rpc<T>(
    name: string,
    body: unknown,
    conflictContext?: {
      scenarioId: string;
      localParentVersionId: string | null;
    },
  ): Promise<T> {
    const response = await this.fetcher(
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`,
      {
        method: 'POST',
        headers: {
          apikey: this.environment.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${this.environment.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      const known = [
        'client_update_required',
        'cloud_device_inactive',
        'cloud_entitlement_missing',
        'scenario_parent_conflict',
        'scenario_write_forbidden',
        'scenario_not_found',
      ];
      const code = known.find((value) => text.includes(value));
      if (code === 'scenario_parent_conflict' && conflictContext) {
        const remoteVersionId = text.match(
          /scenario_parent_conflict:([0-9a-f-]{36})/i,
        )?.[1];
        if (remoteVersionId)
          throw new ScenarioConflictError(
            conflictContext.scenarioId,
            conflictContext.localParentVersionId,
            remoteVersionId,
          );
      }
      throw new CommercialRepositoryError(
        code === 'scenario_parent_conflict'
          ? 409
          : code === 'client_update_required'
            ? 426
            : code?.includes('forbidden') ||
                code?.includes('missing') ||
                code?.includes('inactive')
              ? 403
              : 503,
        code ?? 'cloud_repository_unavailable',
        'Opération cloud refusée.',
      );
    }
    return response.json() as Promise<T>;
  }
}

export class SupabaseScenarioObjectStorage implements ScenarioObjectStorage {
  constructor(
    private readonly environment: WorkerEnvironment,
    private readonly bucket: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async put(input: Parameters<ScenarioObjectStorage['put']>[0]): Promise<void> {
    const body = input.bytes.buffer.slice(
      input.bytes.byteOffset,
      input.bytes.byteOffset + input.bytes.byteLength,
    ) as ArrayBuffer;
    const response = await this.fetcher(
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${this.bucket}/${input.key}`,
      {
        method: 'POST',
        headers: {
          apikey: this.environment.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${this.environment.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': input.contentType,
          'x-upsert': 'true',
          'x-scenario-checksum': input.checksum,
        },
        body,
      },
    );
    if (!response.ok)
      throw new CommercialRepositoryError(
        503,
        'cloud_storage_unavailable',
        'Stockage temporairement indisponible.',
      );
  }
  async temporaryDownload(
    input: Parameters<ScenarioObjectStorage['temporaryDownload']>[0],
  ): Promise<TemporaryObjectGrant> {
    const response = await this.fetcher(
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/sign/${this.bucket}/${input.key}`,
      {
        method: 'POST',
        headers: {
          apikey: this.environment.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${this.environment.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: input.expiresInSeconds }),
      },
    );
    if (!response.ok)
      throw new CommercialRepositoryError(
        503,
        'cloud_storage_unavailable',
        'Téléchargement temporairement indisponible.',
      );
    const value = (await response.json()) as { signedURL?: string };
    if (!value.signedURL)
      throw new CommercialRepositoryError(
        503,
        'cloud_storage_unavailable',
        'URL temporaire indisponible.',
      );
    return {
      url: new URL(value.signedURL, this.environment.SUPABASE_URL).toString(),
      operation: 'download',
      expiresAt: new Date(
        Date.now() + input.expiresInSeconds * 1000,
      ).toISOString(),
    };
  }
}
