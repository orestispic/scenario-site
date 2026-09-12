import type { OfflineGrantPayload } from '../../lib/commercial/contracts-v2.ts';
import { validateMetadataWrite } from '../../lib/commercial/contracts-v10.ts';
import { AuthenticationError } from './jwt.ts';
import {
  CommercialRepositoryError,
  type ActivateDeviceInput,
  type WorkerDependencies,
} from './types.ts';
import { fingerprintActivationKey } from './activationKeys.ts';
import { StripeWebhookError } from './stripeWebhook.ts';
import { normalizeApiRoute, structuredTelemetry } from './observability.ts';
import type { BoundOfflineGrantPayload } from '../../lib/commercial/contracts-v4.ts';
import type {
  AiActionRequest,
  AiOperation,
  AiPdfImportRequest,
} from '../../lib/commercial/contracts-v5.ts';
import {
  AiProviderError,
  type AiProviderInput,
  type AiProviderResult,
} from './aiProvider.ts';
import type { AiReservation } from './aiQuota.ts';
import type { CloudSyncRequest } from '../../lib/commercial/contracts-v6.ts';
import { CLOUD_CONTENT_TYPE, ScenarioConflictError } from './cloudSync.ts';
import type { StudioContext } from './studio.ts';
import type { CollaborativeOperationRequest } from '../../lib/commercial/contracts-v8.ts';
import { buildPublicPlans } from './publicCatalog.ts';

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, 'i');

function uuid(value: unknown, code = 'invalid_scenario_id'): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value))
    throw new ApiError(400, code, 'Identifiant invalide.');
  return value;
}

function cloudPath(
  pathname: string,
): { route: string; scenarioId?: string; versionId?: string } | null {
  const route = normalizeApiRoute(pathname);
  if (!route.startsWith('/v5/')) return null;
  const values = pathname.match(new RegExp(UUID_PATTERN, 'ig')) ?? [];
  return { route, scenarioId: values[0], versionId: values[1] };
}

function studioPath(pathname: string): {
  route: string;
  studioId?: string;
  invitationId?: string;
  memberId?: string;
} | null {
  const route = normalizeApiRoute(pathname);
  if (!route.startsWith('/v6/')) return null;
  const values = pathname.match(new RegExp(UUID_PATTERN, 'ig')) ?? [];
  return {
    route,
    studioId: values[0],
    invitationId: route.includes('/invitations/:') ? values[1] : undefined,
    memberId: route.includes('/members/:') ? values[1] : undefined,
  };
}

function realtimePath(
  pathname: string,
): { route: string; studioId: string } | null {
  const route = normalizeApiRoute(pathname);
  if (!route.startsWith('/v7/')) return null;
  const studioId = pathname.match(new RegExp(UUID_PATTERN, 'i'))?.[0];
  return studioId ? { route, studioId } : null;
}

function readCollaborationOperation(
  value: unknown,
): CollaborativeOperationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(
      400,
      'collaboration_operation_invalid',
      'Opération collaborative invalide.',
    );
  const body = value as Record<string, unknown>;
  assertExactKeys(body, [
    'studioId',
    'scenarioId',
    'baseVersionId',
    'operationId',
    'clientSequence',
    'logicalClock',
    'mutation',
    'checksum',
  ]);
  const mutation = body.mutation;
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation))
    throw new ApiError(
      400,
      'collaboration_operation_invalid',
      'Mutation collaborative invalide.',
    );
  const change = mutation as Record<string, unknown>;
  if (change.type === 'block.upsert') {
    assertExactKeys(change, ['type', 'blockId', 'afterBlockId', 'block']);
    if (
      !change.block ||
      typeof change.block !== 'object' ||
      Array.isArray(change.block)
    )
      throw new ApiError(
        400,
        'collaboration_block_invalid',
        'Bloc collaboratif invalide.',
      );
  } else if (change.type === 'block.delete')
    assertExactKeys(change, ['type', 'blockId']);
  else
    throw new ApiError(
      400,
      'collaboration_mutation_refused',
      'Type de mutation refusé.',
    );
  const blockId = readString(change, 'blockId', 128);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(blockId))
    throw new ApiError(
      400,
      'collaboration_block_invalid',
      'Identifiant de bloc invalide.',
    );
  if (
    change.type === 'block.upsert' &&
    change.afterBlockId !== null &&
    (typeof change.afterBlockId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(change.afterBlockId))
  )
    throw new ApiError(
      400,
      'collaboration_block_invalid',
      'Position de bloc invalide.',
    );
  if (
    !Number.isSafeInteger(body.clientSequence) ||
    Number(body.clientSequence) < 1 ||
    !Number.isSafeInteger(body.logicalClock) ||
    Number(body.logicalClock) < 1
  )
    throw new ApiError(
      400,
      'collaboration_clock_invalid',
      'Horloge collaborative invalide.',
    );
  if (
    typeof body.checksum !== 'string' ||
    !/^[0-9a-f]{64}$/.test(body.checksum)
  )
    throw new ApiError(
      400,
      'collaboration_checksum_invalid',
      'Checksum collaboratif invalide.',
    );
  return {
    studioId: uuid(body.studioId, 'invalid_studio_id'),
    scenarioId: uuid(body.scenarioId),
    baseVersionId: uuid(body.baseVersionId, 'invalid_base_version_id'),
    operationId: uuid(body.operationId, 'invalid_operation_id'),
    clientSequence: Number(body.clientSequence),
    logicalClock: Number(body.logicalClock),
    mutation: structuredClone(
      change,
    ) as unknown as CollaborativeOperationRequest['mutation'],
    checksum: body.checksum,
  };
}

async function strongInvitationToken(
  studioId: string,
  idempotencyKey: string,
  pepper: string,
): Promise<string> {
  // A secret-keyed 256-bit value is reproducible for safe delivery retries but
  // infeasible to predict from the client-controlled idempotency key.
  return `${studioId}.${await hashFingerprint(`${studioId}:${idempotencyKey}`, pepper)}`;
}

function readInvitationEmail(body: Record<string, unknown>): string {
  const email = readString(body, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ApiError(400, 'invalid_email', 'Adresse invalide.');
  return email;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function readCloudHeaders(request: Request, mutation: boolean) {
  const deviceFingerprint =
    request.headers.get('x-scenario-device-fingerprint') ?? '';
  const platform = request.headers.get('x-scenario-platform');
  const clientVersion = request.headers.get('x-scenario-client-version') ?? '';
  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  if (mutation && !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey))
    throw new ApiError(
      400,
      'invalid_idempotency_key',
      'Clé d’idempotence invalide.',
    );
  if (deviceFingerprint.length < 16 || deviceFingerprint.length > 512)
    throw new ApiError(
      400,
      'invalid_fingerprint',
      'Empreinte d’appareil invalide.',
    );
  if (platform !== 'windows' && platform !== 'macos')
    throw new ApiError(400, 'invalid_platform', 'Plateforme invalide.');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(clientVersion))
    throw new ApiError(
      400,
      'invalid_client_version',
      'Version client invalide.',
    );
  return {
    idempotencyKey,
    deviceFingerprint,
    platform: platform as 'windows' | 'macos',
    clientVersion,
  };
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const bytes = value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function readCloudSync(
  request: Request,
  maximum: number,
): Promise<CloudSyncRequest> {
  const body = await readObjectBody(request, maximum);
  assertExactKeys(body, [
    'scenarioId',
    'title',
    'parentVersionId',
    'checksum',
    'sizeBytes',
    'contentType',
    'format',
    'origin',
    'content',
  ]);
  const scenarioId = uuid(body.scenarioId);
  const title = readString(body, 'title', 200);
  const parentVersionId =
    body.parentVersionId === null
      ? null
      : uuid(body.parentVersionId, 'invalid_parent_version_id');
  if (
    body.contentType !== CLOUD_CONTENT_TYPE ||
    body.format !== 'scenario-v1' ||
    !['save', 'import', 'offline_replay'].includes(String(body.origin))
  )
    throw new ApiError(
      415,
      'scenario_format_refused',
      'Format de scénario refusé.',
    );
  if (typeof body.content !== 'string')
    throw new ApiError(400, 'invalid_content', 'Contenu invalide.');
  const bytes = new TextEncoder().encode(body.content);
  if (
    !Number.isSafeInteger(body.sizeBytes) ||
    body.sizeBytes !== bytes.byteLength ||
    bytes.byteLength < 2 ||
    bytes.byteLength > maximum
  )
    throw new ApiError(
      400,
      'scenario_size_mismatch',
      'Taille de scénario invalide.',
    );
  if (
    typeof body.checksum !== 'string' ||
    !/^[0-9a-f]{64}$/.test(body.checksum) ||
    (await sha256Hex(bytes)) !== body.checksum
  )
    throw new ApiError(
      400,
      'scenario_checksum_mismatch',
      'Empreinte de scénario invalide.',
    );
  let document: unknown;
  try {
    document = JSON.parse(body.content);
  } catch {
    throw new ApiError(400, 'invalid_scenario_json', 'Document invalide.');
  }
  if (
    !document ||
    typeof document !== 'object' ||
    (document as { formatVersion?: unknown }).formatVersion !== 1
  )
    throw new ApiError(
      400,
      'scenario_format_refused',
      'Version de format refusée.',
    );
  return {
    scenarioId,
    title,
    parentVersionId,
    checksum: body.checksum,
    sizeBytes: bytes.byteLength,
    contentType: CLOUD_CONTENT_TYPE,
    format: 'scenario-v1',
    origin: body.origin as CloudSyncRequest['origin'],
    content: body.content,
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  origin: string | null,
  allowedOrigins: string[],
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': requestId,
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function emptyResponse(
  status: number,
  requestId: string,
  origin: string | null,
  allowedOrigins: string[],
): Response {
  const headers = new Headers({
    'X-Request-Id': requestId,
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return new Response(null, { status, headers });
}

function validateOrigin(origin: string | null, allowedOrigins: string[]): void {
  if (origin && !allowedOrigins.includes(origin)) {
    throw new ApiError(403, 'origin_forbidden', 'Origine refusée.');
  }
}

async function readObjectBody(
  request: Request,
  maximum = 8_192,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > maximum)
    throw new ApiError(413, 'payload_too_large', 'Requête trop volumineuse.');
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedBody(request, maximum));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'Corps JSON invalide.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_payload', 'Corps de requête invalide.');
  }
  return body as Record<string, unknown>;
}

function assertExactKeys(body: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(body).some((key) => !keys.includes(key))) {
    throw new ApiError(400, 'unexpected_field', 'Champ non autorisé.');
  }
}

function readActivateDevice(
  body: Record<string, unknown>,
  additionalKeys: string[] = [],
): Omit<ActivateDeviceInput, 'fingerprintHash'> & { fingerprint: string } {
  assertExactKeys(body, [
    'fingerprint',
    'label',
    'platform',
    ...additionalKeys,
  ]);
  if (
    typeof body.fingerprint !== 'string' ||
    body.fingerprint.length < 16 ||
    body.fingerprint.length > 512
  ) {
    throw new ApiError(
      400,
      'invalid_fingerprint',
      'Empreinte d’appareil invalide.',
    );
  }
  if (
    typeof body.label !== 'string' ||
    !body.label.trim() ||
    body.label.length > 100
  ) {
    throw new ApiError(400, 'invalid_device_label', 'Nom d’appareil invalide.');
  }
  if (body.platform !== 'windows' && body.platform !== 'macos') {
    throw new ApiError(400, 'invalid_platform', 'Plateforme invalide.');
  }
  return {
    fingerprint: body.fingerprint,
    label: body.label.trim(),
    platform: body.platform,
  };
}

function readDeactivateDevice(body: Record<string, unknown>): string {
  assertExactKeys(body, ['deviceId']);
  if (
    typeof body.deviceId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(body.deviceId)
  ) {
    throw new ApiError(
      400,
      'invalid_device_id',
      'Identifiant d’appareil invalide.',
    );
  }
  return body.deviceId;
}

function readString(
  body: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string {
  const value = body[key];
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximumLength
  )
    throw new ApiError(400, `invalid_${key}`, 'Champ invalide.');
  return value.trim();
}

function readUuid(body: Record<string, unknown>, key: string): string {
  const value = readString(body, key, 64);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new ApiError(400, `invalid_${key}`, 'Identifiant invalide.');
  return value;
}

function validateReturnUrl(value: string, allowedOrigins: string[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, 'invalid_return_url', 'URL de retour invalide.');
  }
  if (!allowedOrigins.includes(url.origin))
    throw new ApiError(400, 'return_url_forbidden', 'URL de retour refusée.');
  return url.toString();
}

async function readRawBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > 1_048_576)
    throw new ApiError(413, 'payload_too_large', 'Événement trop volumineux.');
  const body = await readBoundedBody(request, 1_048_576);
  if (!body || body.length > 1_048_576)
    throw new ApiError(
      400,
      'invalid_payload',
      'Événement vide ou trop volumineux.',
    );
  return body;
}

async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ApiError(
          413,
          'payload_too_large',
          'Requête trop volumineuse.',
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    reader.releaseLock();
  }
}

async function hashFingerprint(
  fingerprint: string,
  pepper: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(fingerprint),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function readAiHeaders(request: Request): {
  idempotencyKey: string;
  deviceFingerprint: string;
  platform: 'windows' | 'macos';
  clientVersion: string;
} {
  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  const deviceFingerprint =
    request.headers.get('x-scenario-device-fingerprint') ?? '';
  const platform = request.headers.get('x-scenario-platform');
  const clientVersion = request.headers.get('x-scenario-client-version') ?? '';
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey))
    throw new ApiError(
      400,
      'invalid_idempotency_key',
      'Clé d’idempotence invalide.',
    );
  if (deviceFingerprint.length < 16 || deviceFingerprint.length > 512)
    throw new ApiError(
      400,
      'invalid_fingerprint',
      'Empreinte d’appareil invalide.',
    );
  if (platform !== 'windows' && platform !== 'macos')
    throw new ApiError(400, 'invalid_platform', 'Plateforme invalide.');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(clientVersion))
    throw new ApiError(
      400,
      'invalid_client_version',
      'Version client invalide.',
    );
  return { idempotencyKey, deviceFingerprint, platform, clientVersion };
}

function readAiAction(
  body: Record<string, unknown>,
  maximumSegments: number,
): AiActionRequest {
  if (body.kind === 'rewrite') {
    assertExactKeys(body, ['kind', 'instruction', 'text']);
    return {
      kind: 'rewrite',
      instruction: readString(body, 'instruction', 10_000),
      text: readString(body, 'text', 200_000),
    };
  }
  if (body.kind !== 'translate')
    throw new ApiError(400, 'invalid_ai_action', 'Action IA invalide.');
  assertExactKeys(body, ['kind', 'targetLanguage', 'segments']);
  const targetLanguage = readString(body, 'targetLanguage', 60);
  if (
    !Array.isArray(body.segments) ||
    body.segments.length < 1 ||
    body.segments.length > maximumSegments
  )
    throw new ApiError(
      400,
      'invalid_segments',
      'Blocs de traduction invalides.',
    );
  const seen = new Set<number>();
  const segments = body.segments.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ApiError(
        400,
        'invalid_segments',
        'Bloc de traduction invalide.',
      );
    const segment = value as Record<string, unknown>;
    assertExactKeys(segment, ['index', 'type', 'text']);
    if (
      !Number.isSafeInteger(segment.index) ||
      (segment.index as number) < 0 ||
      seen.has(segment.index as number)
    )
      throw new ApiError(
        400,
        'invalid_segments',
        'Index de traduction invalide.',
      );
    seen.add(segment.index as number);
    return {
      index: segment.index as number,
      type: readString(segment, 'type', 40),
      text: readString(segment, 'text', 200_000),
    };
  });
  return { kind: 'translate', targetLanguage, segments };
}

function readAiPdf(body: Record<string, unknown>): AiPdfImportRequest {
  assertExactKeys(body, ['extractedText']);
  return { extractedText: readString(body, 'extractedText', 2_000_000) };
}

function quotaView(reservation: AiReservation) {
  return {
    used: reservation.used,
    limit: reservation.limit,
    periodStartsAt: reservation.periodStartsAt,
    periodEndsAt: reservation.periodEndsAt,
  };
}

function validateProviderResult(
  input: AiProviderInput,
  result: AiProviderResult,
  maximumBytes: number,
): void {
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > maximumBytes
  )
    throw new AiProviderError(
      'definitive',
      'ai_response_too_large',
      'Réponse IA trop volumineuse.',
    );
  if (input.operation === 'pdf_import') {
    if (result.kind !== 'scenario_json')
      throw new AiProviderError(
        'definitive',
        'ai_provider_invalid',
        'Réponse IA invalide.',
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.scenarioJson);
    } catch {
      throw new AiProviderError(
        'definitive',
        'ai_provider_invalid',
        'Réponse IA invalide.',
      );
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { formatVersion?: unknown }).formatVersion !== 1
    )
      throw new AiProviderError(
        'definitive',
        'ai_provider_invalid',
        'Document IA invalide.',
      );
    return;
  }
  if (input.request.kind === 'rewrite') {
    if (result.kind !== 'text' || !result.text.trim())
      throw new AiProviderError(
        'definitive',
        'ai_provider_invalid',
        'Réponse IA invalide.',
      );
    return;
  }
  if (
    result.kind !== 'translations' ||
    result.translations.length !== input.request.segments.length
  )
    throw new AiProviderError(
      'definitive',
      'ai_provider_invalid',
      'Traduction IA incomplète.',
    );
  const expected = new Set(input.request.segments.map(({ index }) => index));
  if (
    result.translations.some(
      (item) => !expected.delete(item.index) || !item.text.trim(),
    ) ||
    expected.size
  )
    throw new AiProviderError(
      'definitive',
      'ai_provider_invalid',
      'Traduction IA incohérente.',
    );
}

export function createCommercialWorker(
  dependencies: WorkerDependencies & { deviceFingerprintPepper: string },
) {
  return {
    async fetch(request: Request): Promise<Response> {
      const requestId = crypto.randomUUID();
      const origin = request.headers.get('origin');
      const url = new URL(request.url);
      let profileId: string | null = null;
      let status = 500;
      const startedAt = performance.now();
      let webhook: 'none' | 'processed' | 'replayed' | 'failed' = 'none';
      let ai: 'none' | 'succeeded' | 'replayed' | 'released' | 'uncertain' =
        'none';
      let cloud:
        | 'none'
        | 'synced'
        | 'replayed'
        | 'conflict'
        | 'restored'
        | 'deleted' = 'none';
      let studio: 'none' | 'listed' | 'mutated' | 'replayed' | 'catchup' =
        'none';
      let realtime:
        | 'none'
        | 'ticketed'
        | 'connected'
        | 'heartbeat'
        | 'catchup'
        | 'applied'
        | 'conflict'
        | 'compacted'
        | 'closed'
        | 'rejected' = 'none';
      let connectionRef: string | undefined;
      let connectionCount = 0;
      let backlogDepth = 0;
      let broadcastLatency = 0;

      try {
        validateOrigin(origin, dependencies.allowedOrigins);
        if (request.method === 'OPTIONS') {
          status = 204;
          const response = emptyResponse(
            204,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
          response.headers.set(
            'Access-Control-Allow-Methods',
            'GET, POST, OPTIONS',
          );
          response.headers.set(
            'Access-Control-Allow-Headers',
            'Authorization, Content-Type, Idempotency-Key, X-Scenario-Client-Version, X-Scenario-Device-Fingerprint, X-Scenario-Platform',
          );
          response.headers.set('Access-Control-Max-Age', '600');
          return response;
        }

        const normalizedRoute = normalizeApiRoute(url.pathname);
        if (normalizedRoute === 'unknown')
          throw new ApiError(404, 'route_not_found', 'Route introuvable.');
        if (request.method !== 'GET' && request.method !== 'POST')
          throw new ApiError(405, 'method_not_allowed', 'Méthode refusée.');
        const source = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const sourceHash = await hashFingerprint(
          source,
          dependencies.deviceFingerprintPepper,
        );
        if (
          !(await (dependencies.ingressRateLimiter ?? dependencies.rateLimiter).allow(
            `ingress:${sourceHash}:${normalizedRoute}`,
            Date.now(),
          ))
        )
          throw new ApiError(429, 'rate_limited', 'Trop de requêtes.');
        if (
          request.method === 'POST' &&
          url.pathname !== '/v2/stripe/webhook' &&
          !/^application\/json(?:\s*;|$)/i.test(
            request.headers.get('content-type') ?? '',
          )
        )
          throw new ApiError(415, 'json_required', 'Corps JSON requis.');

        if (url.pathname === '/v11/catalog') {
          if (request.method !== 'GET')
            throw new ApiError(405, 'method_not_allowed', 'Méthode refusée.');
          const offers = await dependencies.billingRepository.listOffers();
          const publicOffers = offers.filter((offer) => offer.testMode).map((offer) => ({
            selectionId: offer.selectionId, offerCode: offer.offerCode,
            displayName: offer.displayName, description: offer.description,
            billingInterval: offer.billingInterval, currency: offer.currency,
            unitAmountMinor: offer.unitAmountMinor, testMode: true,
          }));
          // Deliberate projection: never expose provider IDs, accounts or rights.
          status = 200;
          return jsonResponse({
            contractVersion: '2026-09-v11',
            environment: dependencies.environment,
            testMode: true,
            offers: publicOffers,
            plans: buildPublicPlans(publicOffers),
            request_id: requestId,
          }, status, requestId, origin, dependencies.allowedOrigins);
        }

        if (request.method === 'GET' && url.pathname === '/v1/config') {
          const [configuration, publicKey] = await Promise.all([
            dependencies.repository.getConfiguration(),
            dependencies.offlineGrantSigner.getPublicKey(),
          ]);
          status = 200;
          return jsonResponse(
            {
              ...configuration,
              environment: dependencies.environment,
              offlineGrantPublicKey: publicKey,
              offlineGrantKeyId: dependencies.offlineGrantSigner.keyId,
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'POST' &&
          url.pathname === '/v2/stripe/webhook'
        ) {
          const rawBody = await readRawBody(request);
          webhook = 'failed';
          const event = await dependencies.stripeWebhookVerifier.verify(
            rawBody,
            request.headers.get('stripe-signature'),
          );
          const result = await dependencies.billingRepository.applyStripeEvent(
            event,
            rawBody,
          );
          status = 200;
          webhook = result.replayed ? 'replayed' : 'processed';
          return jsonResponse(
            {
              received: true,
              replayed: result.replayed,
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'POST' &&
          url.pathname === '/v2/activation-keys/redeem'
        ) {
          const source = request.headers.get('cf-connecting-ip') ?? 'unknown';
          const sourceHash = await hashFingerprint(
            source,
            dependencies.deviceFingerprintPepper,
          );
          if (
            !(await dependencies.rateLimiter.allow(
              `activation-attempt:${sourceHash}`,
              Date.now(),
            ))
          ) {
            throw new ApiError(429, 'rate_limited', 'Trop de tentatives.');
          }
        }

        const identity = await dependencies.tokenVerifier.verify(
          request.headers.get('authorization'),
        );
        const profile = await dependencies.repository.getProfile(
          identity.authUserId,
        );
        if (!profile)
          throw new ApiError(
            403,
            'profile_missing',
            'Profil utilisateur indisponible.',
          );
        profileId = profile.id;

        if (
          !(await dependencies.rateLimiter.allow(
            `${profile.id}:${request.method}:${normalizedRoute}`,
            Date.now(),
          ))
        ) {
          throw new ApiError(429, 'rate_limited', 'Trop de requêtes.');
        }

        if (normalizedRoute === '/v10/projects/:id/metadata') {
          if (!dependencies.metadataRepository) throw new ApiError(503, 'project_metadata_unavailable', 'Commentaires et premières pages indisponibles.');
          if (!['GET','POST'].includes(request.method)) throw new ApiError(405,'method_not_allowed','Méthode refusée.');
          const headers=readCloudHeaders(request,request.method==='POST');
          const context:StudioContext={profileId:profile.id,emailHash:'',displayName:'',fingerprintHash:await hashFingerprint(headers.deviceFingerprint,dependencies.deviceFingerprintPepper),platform:headers.platform,clientVersion:headers.clientVersion};
          const input={context,scenarioId:uuid(url.pathname.split('/')[3]),requestId};
          let value;
          if(request.method==='POST') {
            let write;
            try {write=validateMetadataWrite(await readObjectBody(request,131072));}
            catch {throw new ApiError(400,'project_metadata_invalid','Commentaires ou premières pages invalides.');}
            value=await dependencies.metadataRepository.write({...input,write});
          } else value=await dependencies.metadataRepository.read(input);
          status=200; studio=request.method==='POST'?'mutated':'listed';
          if(value.status==='conflict') cloud='conflict';
          return jsonResponse({contractVersion:'2026-09-v10',...value,request_id:requestId},status,requestId,origin,dependencies.allowedOrigins);
        }
        if (normalizedRoute.startsWith('/v9/')) {
          if (!dependencies.projectRepository || !dependencies.studioInvitationPepper)
            throw new ApiError(503, 'projects_unconfigured', 'Projets cloud indisponibles.');
          const mutation = request.method === 'POST';
          const headers = readCloudHeaders(request, mutation);
          const context: StudioContext = {
            profileId: profile.id,
            emailHash: await hashFingerprint(profile.account.email.trim().toLowerCase(), dependencies.studioInvitationPepper),
            displayName: profile.account.displayName ?? 'Membre',
            fingerprintHash: await hashFingerprint(headers.deviceFingerprint, dependencies.deviceFingerprintPepper),
            platform: headers.platform, clientVersion: headers.clientVersion,
          };
          const idempotencyHash = mutation ? await hashFingerprint(`project-v9:${profile.id}:${headers.idempotencyKey}`, dependencies.studioInvitationPepper) : '';
          let value: object;
          if (!mutation && normalizedRoute === '/v9/projects') value = await dependencies.projectRepository.list(context);
          else if (mutation && normalizedRoute === '/v9/projects/:id/sharing') {
            assertExactKeys(await readObjectBody(request), []);
            value = await dependencies.projectRepository.ensureSharing({ context, scenarioId: uuid(url.pathname.split('/')[3]), idempotencyHash, requestId });
          } else if (mutation && normalizedRoute === '/v9/project-invitations/:id/respond') {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['decision']);
            if (body.decision !== 'accept' && body.decision !== 'decline') throw new ApiError(400, 'invalid_invitation_decision', 'Réponse invalide.');
            value = await dependencies.projectRepository.respond({ context, invitationId: uuid(url.pathname.split('/')[3]), decision: body.decision, idempotencyHash, requestId });
          } else throw new ApiError(405, 'method_not_allowed', 'Méthode refusée.');
          status = 200;
          studio = mutation ? 'mutated' : 'listed';
          return jsonResponse({ contractVersion: '2026-09-v9', ...value, request_id: requestId }, status, requestId, origin, dependencies.allowedOrigins);
        }

        const realtimeRoute = realtimePath(url.pathname);
        if (realtimeRoute) {
          if (
            !dependencies.studioRepository ||
            !dependencies.realtimeTransport ||
            !dependencies.studioInvitationPepper
          )
            throw new ApiError(
              503,
              'collaboration_unconfigured',
              'Temps réel Studio indisponible.',
            );
          const headers = readCloudHeaders(request, true);
          const context: StudioContext = {
            profileId: profile.id,
            emailHash: await hashFingerprint(
              profile.account.email.trim().toLowerCase(),
              dependencies.studioInvitationPepper,
            ),
            displayName: profile.account.displayName ?? 'Membre Studio',
            fingerprintHash: await hashFingerprint(
              headers.deviceFingerprint,
              dependencies.deviceFingerprintPepper,
            ),
            platform: headers.platform,
            clientVersion: headers.clientVersion,
          };
          const authorization =
            await dependencies.studioRepository.authorizeRealtime(
              context,
              realtimeRoute.studioId,
              realtimeRoute.route.endsWith('/operations') ||
                realtimeRoute.route.endsWith('/compact'),
            );
          const common = {
            context,
            origin: origin ?? 'native:no-origin',
            studioId: realtimeRoute.studioId,
            requestId,
            authorization: {
              scenarioId: authorization.scenarioId,
              role: authorization.role,
            },
          };
          const respond = (
            value: Record<string, unknown>,
            responseStatus = 200,
          ) => {
            status = responseStatus;
            return jsonResponse(
              {
                contractVersion: '2026-09-v8',
                ...value,
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          };
          if (realtimeRoute.route.endsWith('/tickets')) {
            assertExactKeys(await readObjectBody(request), []);
            const value =
              await dependencies.realtimeTransport.issueTicket(common);
            realtime = 'ticketed';
            return respond(value, 201);
          }
          if (realtimeRoute.route.endsWith('/connect')) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['ticket', 'afterCursor']);
            const afterCursor = Number(body.afterCursor);
            if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
              throw new ApiError(
                400,
                'invalid_collaboration_cursor',
                'Curseur invalide.',
              );
            const value = await dependencies.realtimeTransport.connect({
              ...common,
              ticket: readString(body, 'ticket', 256),
              afterCursor,
            });
            connectionRef = (
              await hashFingerprint(
                value.connectionId,
                dependencies.deviceFingerprintPepper,
              )
            ).slice(0, 16);
            connectionCount = value.presence.reduce(
              (total, member) => total + member.connectionCount,
              0,
            );
            realtime = 'connected';
            return respond(value, 201);
          }
          if (realtimeRoute.route.endsWith('/heartbeat')) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['connectionId']);
            const value = await dependencies.realtimeTransport.heartbeat({
              ...common,
              connectionId: uuid(body.connectionId, 'invalid_connection_id'),
            });
            connectionRef = (
              await hashFingerprint(
                String(body.connectionId),
                dependencies.deviceFingerprintPepper,
              )
            ).slice(0, 16);
            connectionCount = value.presence.reduce(
              (total, member) => total + member.connectionCount,
              0,
            );
            realtime = 'heartbeat';
            return respond(value);
          }
          if (realtimeRoute.route.endsWith('/poll')) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['connectionId', 'afterCursor']);
            const afterCursor = Number(body.afterCursor);
            if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
              throw new ApiError(
                400,
                'invalid_collaboration_cursor',
                'Curseur invalide.',
              );
            const value = await dependencies.realtimeTransport.poll({
              ...common,
              connectionId: uuid(body.connectionId, 'invalid_connection_id'),
              afterCursor,
            });
            connectionRef = (
              await hashFingerprint(
                String(body.connectionId),
                dependencies.deviceFingerprintPepper,
              )
            ).slice(0, 16);
            backlogDepth = value.syncLag;
            realtime = 'catchup';
            return respond(value);
          }
          if (realtimeRoute.route.endsWith('/operations')) {
            const maximum =
              'policy' in dependencies.realtimeTransport &&
              typeof (
                dependencies.realtimeTransport as {
                  policy?: { maximumOperationBytes?: number };
                }
              ).policy?.maximumOperationBytes === 'number'
                ? (
                    dependencies.realtimeTransport as {
                      policy: { maximumOperationBytes: number };
                    }
                  ).policy.maximumOperationBytes + 2_048
                : 67_584;
            const body = await readObjectBody(request, maximum);
            assertExactKeys(body, ['connectionId', 'operation']);
            const operation = readCollaborationOperation(body.operation);
            if (operation.studioId !== realtimeRoute.studioId)
              throw new ApiError(
                400,
                'collaboration_scope_invalid',
                'Portée collaborative invalide.',
              );
            connectionRef = (
              await hashFingerprint(
                String(body.connectionId),
                dependencies.deviceFingerprintPepper,
              )
            ).slice(0, 16);
            const broadcastStartedAt = performance.now();
            const value = await dependencies.realtimeTransport.submit({
              ...common,
              connectionId: uuid(body.connectionId, 'invalid_connection_id'),
              operation,
              requestId,
            });
            broadcastLatency = Math.max(
              0,
              Math.round(performance.now() - broadcastStartedAt),
            );
            realtime = value.status === 'conflict' ? 'conflict' : 'applied';
            return respond(value);
          }
          if (realtimeRoute.route.endsWith('/compact')) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['connectionId', 'parentVersionId']);
            const value = await dependencies.realtimeTransport.compact({
              ...common,
              connectionId: uuid(body.connectionId, 'invalid_connection_id'),
              parentVersionId: uuid(
                body.parentVersionId,
                'invalid_parent_version_id',
              ),
              idempotencyHash: await hashFingerprint(
                `${profile.id}:${headers.idempotencyKey}:compact`,
                dependencies.studioInvitationPepper,
              ),
              requestId,
            });
            connectionRef = (
              await hashFingerprint(
                String(body.connectionId),
                dependencies.deviceFingerprintPepper,
              )
            ).slice(0, 16);
            realtime = 'compacted';
            return respond(value, value.replayed ? 200 : 201);
          }
          if (realtimeRoute.route.endsWith('/disconnect')) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['connectionId']);
            await dependencies.realtimeTransport.disconnect({
              ...common,
              connectionId: uuid(body.connectionId, 'invalid_connection_id'),
            });
            connectionRef = (
              await hashFingerprint(
                String(body.connectionId),
                dependencies.deviceFingerprintPepper,
              )
            ).slice(0, 16);
            realtime = 'closed';
            return respond({ closed: true });
          }
          throw new ApiError(405, 'method_not_allowed', 'Méthode refusée.');
        }

        const studioRoute = studioPath(url.pathname);
        if (studioRoute) {
          if (
            !dependencies.studioRepository ||
            !dependencies.studioNotifier ||
            !dependencies.studioInvitationPepper ||
            !dependencies.studioPolicy
          )
            throw new ApiError(
              503,
              'studio_unconfigured',
              'Studio indisponible.',
            );
          const mutation = request.method === 'POST';
          const headers = readCloudHeaders(request, mutation);
          const context: StudioContext = {
            profileId: profile.id,
            emailHash: await hashFingerprint(
              profile.account.email.trim().toLowerCase(),
              dependencies.studioInvitationPepper,
            ),
            displayName: profile.account.displayName ?? 'Membre Studio',
            fingerprintHash: await hashFingerprint(
              headers.deviceFingerprint,
              dependencies.deviceFingerprintPepper,
            ),
            platform: headers.platform,
            clientVersion: headers.clientVersion,
          };
          const idempotencyHash = mutation
            ? await hashFingerprint(
                `${profile.id}:${headers.idempotencyKey}`,
                dependencies.studioInvitationPepper,
              )
            : '';
          const response = (
            value: Record<string, unknown>,
            responseStatus = 200,
          ) => {
            status = responseStatus;
            studio =
              value.replayed === true
                ? 'replayed'
                : mutation
                  ? 'mutated'
                  : studioRoute.route.endsWith('/events')
                    ? 'catchup'
                    : 'listed';
            return jsonResponse(
              {
                contractVersion: '2026-09-v7',
                ...value,
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          };
          if (request.method === 'GET' && studioRoute.route === '/v6/studios') {
            const [studios, pending] = await Promise.all([
              dependencies.studioRepository.list(context),
              dependencies.studioRepository.receivedInvitations(context),
            ]);
            const receivedInvitations = pending.map((invitation) => ({
              ...invitation,
              ...(dependencies.environment === 'test' &&
              dependencies.studioNotifier!.developmentToken
                ? {
                    developmentToken:
                      dependencies.studioNotifier!.developmentToken(
                        invitation.id,
                        context.emailHash,
                      ),
                  }
                : {}),
            }));
            return response({ studios, receivedInvitations });
          }
          if (
            request.method === 'POST' &&
            studioRoute.route === '/v6/studios'
          ) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['scenarioId', 'name']);
            const result = await dependencies.studioRepository.create({
              context,
              scenarioId: uuid(body.scenarioId),
              name: readString(body, 'name', 120),
              idempotencyHash,
              requestId,
            });
            return response(result, result.replayed ? 200 : 201);
          }
          if (
            request.method === 'GET' &&
            studioRoute.route === '/v6/studios/:id'
          ) {
            return response(
              await dependencies.studioRepository.detail(
                context,
                studioRoute.studioId!,
              ),
            );
          }
          if (
            request.method === 'POST' &&
            studioRoute.route === '/v6/studios/:id/invitations'
          ) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['email', 'role']);
            const email = readInvitationEmail(body);
            if (body.role !== 'editor' && body.role !== 'viewer')
              throw new ApiError(400, 'invalid_studio_role', 'Rôle refusé.');
            const token = await strongInvitationToken(
              studioRoute.studioId!,
              headers.idempotencyKey,
              dependencies.studioInvitationPepper,
            );
            const recipientEmailHash = await hashFingerprint(
              email,
              dependencies.studioInvitationPepper,
            );
            const tokenHash = await hashFingerprint(
              token,
              dependencies.studioInvitationPepper,
            );
            const expiresAt = new Date(
              Date.now() +
                dependencies.studioPolicy.invitationTtlSeconds * 1_000,
            ).toISOString();
            const result = await dependencies.studioRepository.invite({
              context,
              studioId: studioRoute.studioId!,
              recipientEmailHash,
              recipientMasked: maskEmail(email),
              role: body.role,
              tokenHash,
              expiresAt,
              idempotencyHash,
              requestId,
            });
            try {
              // Providers deduplicate by invitationId. Replays deliberately retry
              // delivery with the same derived token after an uncertain outage.
              await dependencies.studioNotifier.deliver({
                invitationId: result.invitation.id,
                recipientEmailHash,
                token,
                expiresAt: result.invitation.expiresAt,
              });
            } catch {
              console.warn(
                JSON.stringify({
                  event: 'studio.notification_unavailable',
                  request_id: requestId,
                }),
              );
            }
            return response(result, result.replayed ? 200 : 201);
          }
          if (
            request.method === 'POST' &&
            [
              '/v6/studio-invitations/accept',
              '/v6/studio-invitations/decline',
            ].includes(studioRoute.route)
          ) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['token']);
            const token = readString(body, 'token', 256);
            if (
              !new RegExp(`^${UUID_PATTERN}\\.[0-9a-f]{64}$`, 'i').test(token)
            )
              throw new ApiError(
                400,
                'invalid_invitation_token',
                'Invitation invalide.',
              );
            const input = {
              context,
              tokenHash: await hashFingerprint(
                token,
                dependencies.studioInvitationPepper,
              ),
              idempotencyHash,
              requestId,
            };
            const result = studioRoute.route.endsWith('/accept')
              ? await dependencies.studioRepository.accept(input)
              : await dependencies.studioRepository.decline(input);
            return response(result, result.replayed ? 200 : 201);
          }
          if (
            request.method === 'POST' &&
            studioRoute.route ===
              '/v6/studios/:id/invitations/:invitationId/revoke'
          ) {
            assertExactKeys(await readObjectBody(request), []);
            return response(
              await dependencies.studioRepository.revokeInvitation({
                context,
                studioId: studioRoute.studioId!,
                invitationId: studioRoute.invitationId!,
                idempotencyHash,
                requestId,
              }),
            );
          }
          if (
            request.method === 'POST' &&
            studioRoute.route === '/v6/studios/:id/members/:profileId/role'
          ) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['role']);
            if (!['owner', 'editor', 'viewer'].includes(String(body.role)))
              throw new ApiError(400, 'invalid_studio_role', 'Rôle refusé.');
            const result = await dependencies.studioRepository.changeRole({
              context,
              studioId: studioRoute.studioId!,
              profileId: studioRoute.memberId!,
              role: body.role as 'owner' | 'editor' | 'viewer',
              idempotencyHash,
              requestId,
            });
            await dependencies.realtimeTransport?.revokeStudioMember(
              studioRoute.studioId!,
              studioRoute.memberId!,
            );
            return response(result);
          }
          if (
            request.method === 'POST' &&
            studioRoute.route === '/v6/studios/:id/members/:profileId/remove'
          ) {
            assertExactKeys(await readObjectBody(request), []);
            const result = await dependencies.studioRepository.removeMember({
              context,
              studioId: studioRoute.studioId!,
              profileId: studioRoute.memberId!,
              idempotencyHash,
              requestId,
            });
            await dependencies.realtimeTransport?.revokeStudioMember(
              studioRoute.studioId!,
              studioRoute.memberId!,
            );
            return response(result);
          }
          if (
            request.method === 'GET' &&
            studioRoute.route === '/v6/studios/:id/events'
          ) {
            const after = Number(url.searchParams.get('after') ?? 0);
            const limit = Number(
              url.searchParams.get('limit') ??
                dependencies.studioPolicy.eventPageSize,
            );
            if (
              !Number.isSafeInteger(after) ||
              after < 0 ||
              !Number.isSafeInteger(limit) ||
              limit < 1 ||
              limit > dependencies.studioPolicy.eventPageSize
            )
              throw new ApiError(
                400,
                'invalid_studio_cursor',
                'Curseur invalide.',
              );
            return response(
              await dependencies.studioRepository.events(
                context,
                studioRoute.studioId!,
                after,
                limit,
              ),
            );
          }
          throw new ApiError(405, 'method_not_allowed', 'Méthode refusée.');
        }

        const cloudRoute = cloudPath(url.pathname);
        if (cloudRoute) {
          if (
            !dependencies.cloudRepository ||
            !dependencies.scenarioStorage ||
            !dependencies.cloudIdempotencyPepper ||
            !dependencies.cloudPolicy
          )
            throw new ApiError(
              503,
              'cloud_unconfigured',
              'Synchronisation cloud indisponible.',
            );
          const mutation = request.method === 'POST';
          const contextHeader = readCloudHeaders(request, mutation);
          const context = {
            profileId: profile.id,
            fingerprintHash: await hashFingerprint(
              contextHeader.deviceFingerprint,
              dependencies.deviceFingerprintPepper,
            ),
            platform: contextHeader.platform,
            clientVersion: contextHeader.clientVersion,
          };
          if (
            request.method === 'GET' &&
            cloudRoute.route === '/v5/scenarios'
          ) {
            const scenarios = await dependencies.cloudRepository.list(context);
            status = 200;
            return jsonResponse(
              {
                contractVersion: '2026-09-v6',
                scenarios,
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          }
          if (
            request.method === 'GET' &&
            cloudRoute.route === '/v5/scenarios/:id/versions'
          ) {
            const versions = await dependencies.cloudRepository.versions(
              context,
              cloudRoute.scenarioId!,
            );
            status = 200;
            return jsonResponse(
              {
                contractVersion: '2026-09-v6',
                versions,
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          }
          if (
            request.method === 'GET' &&
            cloudRoute.route ===
              '/v5/scenarios/:id/versions/:versionId/download'
          ) {
            const key = await dependencies.cloudRepository.storageKey(
              context,
              cloudRoute.scenarioId!,
              cloudRoute.versionId!,
            );
            const download =
              await dependencies.scenarioStorage.temporaryDownload({
                key,
                profileId: profile.id,
                scenarioId: cloudRoute.scenarioId!,
                expiresInSeconds: dependencies.cloudPolicy.downloadTtlSeconds,
              });
            status = 200;
            return jsonResponse(
              {
                contractVersion: '2026-09-v6',
                download,
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          }
          if (
            request.method === 'POST' &&
            cloudRoute.route === '/v5/scenarios/sync'
          ) {
            // Reject rights/version/device before accepting any object bytes.
            await dependencies.cloudRepository.authorize(context);
            const sync = await readCloudSync(
              request,
              dependencies.cloudPolicy.maximumBodyBytes,
            );
            const { content, ...metadata } = sync;
            const idempotencyHash = await hashFingerprint(
              `${profile.id}:${contextHeader.idempotencyKey}`,
              dependencies.cloudIdempotencyPepper,
            );
            const requestFingerprint = await sha256Hex(
              new TextEncoder().encode(canonicalJson(metadata)),
            );
            const accountScope = await hashFingerprint(
              profile.id,
              dependencies.cloudIdempotencyPepper,
            );
            const storageKey = `${accountScope}/scenarios/${sync.scenarioId}/objects/${sync.checksum}.scenario`;
            await dependencies.scenarioStorage.put({
              key: storageKey,
              bytes: new TextEncoder().encode(content),
              contentType: sync.contentType,
              checksum: sync.checksum,
            });
            const result = await dependencies.cloudRepository.sync({
              context,
              request: metadata,
              storageKey,
              idempotencyHash,
              requestFingerprint,
              requestId,
            });
            if (!result.replayed && dependencies.studioRepository) {
              try {
                await dependencies.studioRepository.publishScenarioVersion({
                  scenarioId: sync.scenarioId,
                  versionId: result.version.id,
                  requestId,
                });
              } catch {
                console.warn(
                  JSON.stringify({
                    event: 'studio.event_deferred',
                    request_id: requestId,
                  }),
                );
              }
            }
            const download =
              await dependencies.scenarioStorage.temporaryDownload({
                key: storageKey,
                profileId: profile.id,
                scenarioId: sync.scenarioId,
                expiresInSeconds: dependencies.cloudPolicy.downloadTtlSeconds,
              });
            cloud = result.replayed ? 'replayed' : 'synced';
            status = result.replayed ? 200 : 201;
            return jsonResponse(
              {
                contractVersion: '2026-09-v6',
                ...result,
                download,
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          }
          if (
            request.method === 'POST' &&
            cloudRoute.route === '/v5/scenarios/:id/restore'
          ) {
            const body = await readObjectBody(request);
            assertExactKeys(body, ['versionId']);
            const versionId = uuid(body.versionId, 'invalid_version_id');
            const idempotencyHash = await hashFingerprint(
              `${profile.id}:${contextHeader.idempotencyKey}`,
              dependencies.cloudIdempotencyPepper,
            );
            const result = await dependencies.cloudRepository.restore({
              context,
              scenarioId: cloudRoute.scenarioId!,
              versionId,
              idempotencyHash,
              requestId,
            });
            if (!result.replayed && dependencies.studioRepository) {
              try {
                await dependencies.studioRepository.publishScenarioVersion({
                  scenarioId: cloudRoute.scenarioId!,
                  versionId: result.version.id,
                  requestId,
                });
              } catch {
                console.warn(
                  JSON.stringify({
                    event: 'studio.event_deferred',
                    request_id: requestId,
                  }),
                );
              }
            }
            const download =
              await dependencies.scenarioStorage.temporaryDownload({
                key: result.storageKey,
                profileId: profile.id,
                scenarioId: cloudRoute.scenarioId!,
                expiresInSeconds: dependencies.cloudPolicy.downloadTtlSeconds,
              });
            const { storageKey: _storageKey, ...publicResult } = result;
            cloud = result.replayed ? 'replayed' : 'restored';
            status = result.replayed ? 200 : 201;
            return jsonResponse(
              {
                contractVersion: '2026-09-v6',
                ...publicResult,
                download,
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          }
          if (
            request.method === 'POST' &&
            cloudRoute.route === '/v5/scenarios/:id/delete'
          ) {
            const body = await readObjectBody(request);
            assertExactKeys(body, []);
            const idempotencyHash = await hashFingerprint(
              `${profile.id}:${contextHeader.idempotencyKey}`,
              dependencies.cloudIdempotencyPepper,
            );
            const scenario = await dependencies.cloudRepository.softDelete({
              context,
              scenarioId: cloudRoute.scenarioId!,
              idempotencyHash,
              requestId,
            });
            cloud = 'deleted';
            status = 200;
            return jsonResponse(
              {
                contractVersion: '2026-09-v6',
                scenario,
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          }
          throw new ApiError(405, 'method_not_allowed', 'Méthode refusée.');
        }

        if (
          request.method === 'POST' &&
          ['/v4/ai/actions', '/v4/ai/pdf-imports'].includes(url.pathname)
        ) {
          if (
            !dependencies.aiProvider ||
            !dependencies.aiQuotaRepository ||
            !dependencies.aiIdempotencyPepper ||
            !dependencies.aiPolicy
          )
            throw new ApiError(
              503,
              'ai_unconfigured',
              'Service IA indisponible.',
            );
          const context = readAiHeaders(request);
          const operation: AiOperation =
            url.pathname === '/v4/ai/actions' ? 'short_action' : 'pdf_import';
          const body = await readObjectBody(
            request,
            operation === 'short_action'
              ? dependencies.aiPolicy.shortMaxBodyBytes
              : dependencies.aiPolicy.pdfMaxBodyBytes,
          );
          const providerInput: AiProviderInput =
            operation === 'short_action'
              ? {
                  operation,
                  request: readAiAction(
                    body,
                    dependencies.aiPolicy.maxTranslationSegments,
                  ),
                }
              : { operation, request: readAiPdf(body) };
          const idempotencyKeyHash = await hashFingerprint(
            `${profile.id}:idempotency:${context.idempotencyKey}`,
            dependencies.aiIdempotencyPepper,
          );
          const requestFingerprint = await hashFingerprint(
            `content:${canonicalJson(providerInput)}`,
            dependencies.aiIdempotencyPepper,
          );
          let reservation = await dependencies.aiQuotaRepository.reserve({
            profileId: profile.id,
            operation,
            entitlementCode:
              operation === 'short_action'
                ? 'ai_short_action'
                : 'ai_pdf_import',
            quotaCode:
              operation === 'short_action'
                ? 'ai_short_action'
                : 'ai_pdf_import',
            deviceFingerprintHash: await hashFingerprint(
              context.deviceFingerprint,
              dependencies.deviceFingerprintPepper,
            ),
            platform: context.platform,
            clientVersion: context.clientVersion,
            idempotencyKeyHash,
            requestFingerprint,
            requestId,
          });
          if (reservation.replayed) {
            ai = 'replayed';
            if (reservation.status === 'released')
              throw new ApiError(
                409,
                'ai_request_released',
                'Cette tentative a été annulée. Utilisez une nouvelle demande.',
              );
            status = reservation.status === 'succeeded' ? 200 : 202;
            return jsonResponse(
              {
                contractVersion: '2026-09-v5',
                operation,
                status: reservation.status,
                result: null,
                replayed: true,
                quota: quotaView(reservation),
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          }
          if (request.signal.aborted) {
            reservation = await dependencies.aiQuotaRepository.release(
              profile.id,
              reservation.id,
            );
            ai = 'released';
            throw new ApiError(
              408,
              'ai_request_cancelled',
              'Demande IA annulée.',
            );
          }
          try {
            const result = await dependencies.aiProvider.execute(
              providerInput,
              requestId,
            );
            validateProviderResult(
              providerInput,
              result,
              dependencies.aiPolicy.maxResponseBytes,
            );
            reservation = await dependencies.aiQuotaRepository.confirm(
              profile.id,
              reservation.id,
            );
            ai = 'succeeded';
            status = 200;
            return jsonResponse(
              {
                contractVersion: '2026-09-v5',
                operation,
                status: reservation.status,
                result,
                replayed: false,
                quota: quotaView(reservation),
                request_id: requestId,
              },
              status,
              requestId,
              origin,
              dependencies.allowedOrigins,
            );
          } catch (error) {
            const providerError =
              error instanceof AiProviderError
                ? error
                : new AiProviderError(
                    'uncertain',
                    'ai_provider_unavailable',
                    'Fournisseur IA indisponible.',
                  );
            if (providerError.certainty === 'uncertain') {
              await dependencies.aiQuotaRepository.markUncertain(
                profile.id,
                reservation.id,
              );
              ai = 'uncertain';
              throw new ApiError(
                504,
                providerError.code,
                'Résultat IA incertain. Réconciliez cette demande avant de réessayer.',
              );
            }
            await dependencies.aiQuotaRepository.release(
              profile.id,
              reservation.id,
            );
            ai = 'released';
            throw new ApiError(502, providerError.code, providerError.message);
          }
        }

        if (request.method === 'POST' && url.pathname === '/v4/ai/reconcile') {
          if (
            !dependencies.aiQuotaRepository ||
            !dependencies.aiIdempotencyPepper
          )
            throw new ApiError(
              503,
              'ai_unconfigured',
              'Service IA indisponible.',
            );
          const body = await readObjectBody(request);
          assertExactKeys(body, ['idempotencyKey']);
          const idempotencyKey = readString(body, 'idempotencyKey', 128);
          if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey))
            throw new ApiError(
              400,
              'invalid_idempotency_key',
              'Clé d’idempotence invalide.',
            );
          const idempotencyKeyHash = await hashFingerprint(
            `${profile.id}:idempotency:${idempotencyKey}`,
            dependencies.aiIdempotencyPepper,
          );
          const reservation = await dependencies.aiQuotaRepository.reconcile(
            profile.id,
            idempotencyKeyHash,
          );
          if (!reservation)
            throw new ApiError(
              404,
              'ai_request_missing',
              'Demande IA introuvable.',
            );
          ai = 'replayed';
          status = 200;
          return jsonResponse(
            {
              contractVersion: '2026-09-v5',
              operation: reservation.operation,
              status: reservation.status,
              replayed: true,
              quota: quotaView(reservation),
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (request.method === 'GET' && url.pathname === '/v1/me') {
          status = 200;
          return jsonResponse(
            {
              account: profile.account,
              role: profile.role,
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'GET' &&
          ['/v1/entitlements', '/v3/entitlements'].includes(url.pathname)
        ) {
          const entitlements = await dependencies.repository.getEntitlements(
            profile.id,
          );
          if (!entitlements)
            throw new ApiError(
              403,
              'entitlements_missing',
              'Droits indisponibles.',
            );
          const payload: OfflineGrantPayload = {
            userId: profile.id,
            deviceId: null,
            snapshotId: entitlements.snapshot.id,
            configurationVersion: entitlements.snapshot.configurationVersion,
            issuedAt: entitlements.snapshot.issuedAt,
            expiresAt: entitlements.snapshot.offlineValidUntil,
          };
          const boundPayload: BoundOfflineGrantPayload = {
            ...payload,
            contractVersion: '2026-09-v4',
            snapshotJson: JSON.stringify(entitlements.snapshot),
          };
          status = 200;
          return jsonResponse(
            {
              snapshot: entitlements.snapshot,
              offlineGrant: await dependencies.offlineGrantSigner.sign(
                url.pathname === '/v3/entitlements' ? boundPayload : payload,
              ),
              ...(url.pathname === '/v3/entitlements'
                ? { contractVersion: '2026-09-v4' }
                : {}),
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (request.method === 'GET' && url.pathname === '/v1/devices') {
          status = 200;
          return jsonResponse(
            {
              devices: await dependencies.repository.listDevices(profile.id),
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'POST' &&
          url.pathname === '/v1/devices/activate'
        ) {
          const input = readActivateDevice(await readObjectBody(request));
          const device = await dependencies.repository.activateDevice(
            profile.id,
            {
              fingerprintHash: await hashFingerprint(
                input.fingerprint,
                dependencies.deviceFingerprintPepper,
              ),
              label: input.label,
              platform: input.platform,
            },
          );
          await dependencies.repository.appendAudit({
            profileId,
            action: 'device.activate',
            entityType: 'device',
            entityId: device.id,
            requestId,
          });
          status = 201;
          return jsonResponse(
            { device, request_id: requestId },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'POST' &&
          url.pathname === '/v1/devices/deactivate'
        ) {
          const deviceId = readDeactivateDevice(await readObjectBody(request));
          await dependencies.repository.deactivateDevice(profile.id, deviceId);
          await dependencies.realtimeTransport?.revokeProfile(profile.id);
          await dependencies.repository.appendAudit({
            profileId,
            action: 'device.deactivate',
            entityType: 'device',
            entityId: deviceId,
            requestId,
          });
          status = 204;
          return emptyResponse(
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (request.method === 'GET' && url.pathname === '/v1/usage') {
          status = 200;
          return jsonResponse(
            {
              usage: await dependencies.repository.getUsage(profile.id),
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (request.method === 'GET' && url.pathname === '/v2/billing') {
          const [offers, billing] = await Promise.all([
            dependencies.billingRepository.listOffers(),
            dependencies.billingRepository.getBillingState(profile.id),
          ]);
          status = 200;
          return jsonResponse(
            { offers, billing, request_id: requestId },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'POST' &&
          url.pathname === '/v2/checkout/sessions'
        ) {
          const body = await readObjectBody(request);
          assertExactKeys(body, ['selectionId', 'successUrl', 'cancelUrl']);
          const selectionId = readUuid(body, 'selectionId');
          const selection =
            await dependencies.billingRepository.getSelection(selectionId);
          if (!selection)
            throw new ApiError(
              404,
              'billing_selection_missing',
              'Offre indisponible.',
            );
          const checkout =
            await dependencies.stripeGateway.createCheckoutSession({
              priceReference: selection.providerPriceReference,
              profileId: profile.id,
              customerEmail: profile.account.email,
              successUrl: validateReturnUrl(
                readString(body, 'successUrl', 2_048),
                dependencies.allowedOrigins,
              ),
              cancelUrl: validateReturnUrl(
                readString(body, 'cancelUrl', 2_048),
                dependencies.allowedOrigins,
              ),
              idempotencyKey: `checkout:${profile.id}:${requestId}`,
            });
          await dependencies.billingRepository.recordCheckoutSession({
            profileId: profile.id,
            selectionId,
            providerSessionId: checkout.id,
            expiresAt: checkout.expiresAt,
          });
          await dependencies.repository.appendAudit({
            profileId,
            action: 'billing.checkout.created',
            entityType: 'checkout_session',
            entityId: checkout.id,
            requestId,
          });
          status = 201;
          return jsonResponse(
            {
              checkoutUrl: checkout.url,
              expiresAt: checkout.expiresAt,
              testMode: true,
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'POST' &&
          url.pathname === '/v2/billing/portal-sessions'
        ) {
          const body = await readObjectBody(request);
          assertExactKeys(body, ['returnUrl']);
          const customerReference =
            await dependencies.billingRepository.getCustomerReference(
              profile.id,
            );
          if (!customerReference)
            throw new ApiError(
              409,
              'billing_customer_missing',
              'Aucun compte de facturation n’est encore associé.',
            );
          const portal = await dependencies.stripeGateway.createPortalSession({
            customerReference,
            returnUrl: validateReturnUrl(
              readString(body, 'returnUrl', 2_048),
              dependencies.allowedOrigins,
            ),
            idempotencyKey: `portal:${profile.id}:${requestId}`,
          });
          await dependencies.repository.appendAudit({
            profileId,
            action: 'billing.portal.created',
            entityType: 'billing_customer',
            requestId,
          });
          status = 201;
          return jsonResponse(
            { portalUrl: portal.url, testMode: true, request_id: requestId },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'GET' &&
          url.pathname === '/v2/activation-keys/status'
        ) {
          status = 200;
          return jsonResponse(
            {
              activations: await dependencies.billingRepository.listActivations(
                profile.id,
              ),
              request_id: requestId,
            },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'POST' &&
          url.pathname === '/v2/activation-keys/redeem'
        ) {
          const body = await readObjectBody(request);
          assertExactKeys(body, ['key', 'fingerprint', 'label', 'platform']);
          const deviceInput = readActivateDevice(body, ['key']);
          const key = readString(body, 'key', 160);
          const result =
            await dependencies.billingRepository.redeemActivationKey({
              profileId: profile.id,
              keyHash: await fingerprintActivationKey(
                key,
                dependencies.activationKeyPepper,
              ),
              device: {
                fingerprintHash: await hashFingerprint(
                  deviceInput.fingerprint,
                  dependencies.deviceFingerprintPepper,
                ),
                label: deviceInput.label,
                platform: deviceInput.platform,
              },
            });
          await dependencies.repository.appendAudit({
            profileId,
            action: 'activation_key.redeem',
            entityType: 'activation_key',
            entityId: result.activation.id,
            requestId,
          });
          status = 201;
          return jsonResponse(
            { ...result, request_id: requestId },
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (
          request.method === 'POST' &&
          url.pathname === '/v2/activation-keys/revoke'
        ) {
          if (profile.role !== 'admin')
            throw new ApiError(
              403,
              'admin_required',
              'Action administrative refusée.',
            );
          const body = await readObjectBody(request);
          assertExactKeys(body, ['keyId']);
          const keyId = readUuid(body, 'keyId');
          await dependencies.billingRepository.revokeActivationKey({
            keyId,
            actorProfileId: profile.id,
          });
          await dependencies.repository.appendAudit({
            profileId,
            action: 'activation_key.revoke',
            entityType: 'activation_key',
            entityId: keyId,
            requestId,
          });
          status = 204;
          return emptyResponse(
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        if (request.method === 'POST' && url.pathname === '/v1/auth/logout') {
          assertExactKeys(await readObjectBody(request), []);
          await dependencies.repository.logout(identity.accessToken);
          await dependencies.realtimeTransport?.revokeProfile(profile.id);
          await dependencies.repository.appendAudit({
            profileId,
            action: 'session.logout',
            entityType: 'session',
            requestId,
          });
          status = 204;
          return emptyResponse(
            status,
            requestId,
            origin,
            dependencies.allowedOrigins,
          );
        }

        throw new ApiError(404, 'route_not_found', 'Route introuvable.');
      } catch (error) {
        if (normalizeApiRoute(url.pathname).startsWith('/v7/'))
          realtime = 'rejected';
        if (
          request.method === 'POST' &&
          url.pathname === '/v2/activation-keys/redeem'
        ) {
          try {
            await dependencies.repository.appendAudit({
              profileId,
              action: 'activation_key.redeem_failed',
              entityType: 'activation_key',
              requestId,
            });
          } catch {
            console.warn(
              JSON.stringify({
                event: 'audit.unavailable',
                request_id: requestId,
              }),
            );
          }
        }
        const apiError =
          error instanceof ApiError
            ? error
            : error instanceof CommercialRepositoryError
              ? new ApiError(
                  error.status,
                  error.code,
                  error.message,
                  error instanceof ScenarioConflictError
                    ? {
                        conflict: {
                          code: 'scenario_parent_conflict',
                          scenarioId: error.scenarioId,
                          localParentVersionId: error.localParentVersionId,
                          remoteVersionId: error.remoteVersionId,
                          options: [
                            'keep_local',
                            'download_remote',
                            'create_copy',
                          ],
                        },
                      }
                    : undefined,
                )
              : error instanceof StripeWebhookError
                ? new ApiError(400, 'stripe_signature_invalid', error.message)
                : error instanceof AuthenticationError
                  ? new ApiError(401, 'authentication_required', error.message)
                  : new ApiError(500, 'internal_error', 'Erreur interne.');
        status = apiError.status;
        return jsonResponse(
          {
            code: apiError.code,
            message: apiError.message,
            request_id: requestId,
            ...apiError.details,
          },
          status,
          requestId,
          origin,
          dependencies.allowedOrigins,
        );
      } finally {
        try {
          (dependencies.telemetry ?? structuredTelemetry).record({
            request_id: requestId,
            method: request.method,
            route: normalizeApiRoute(url.pathname),
            status,
            duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
            outcome:
              status >= 500 ? 'unavailable' : status >= 400 ? 'rejected' : 'ok',
            webhook,
            ai,
            cloud,
            studio,
            realtime,
            connection_ref: connectionRef,
            connection_count: connectionCount,
            backlog_depth: backlogDepth,
            broadcast_latency_ms: broadcastLatency,
          });
        } catch {
          /* Observability failure must not replay a successful mutation. */
        }
      }
    },
  };
}
