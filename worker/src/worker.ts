import type { OfflineGrantPayload } from '../../lib/commercial/contracts-v2.ts';
import { AuthenticationError } from './jwt.ts';
import {
  CommercialRepositoryError,
  type ActivateDeviceInput,
  type WorkerDependencies,
} from './types.ts';
import { fingerprintActivationKey } from './activationKeys.ts';
import { StripeWebhookError } from './stripeWebhook.ts';
import { API_ROUTES, structuredTelemetry } from './observability.ts';
import type { BoundOfflineGrantPayload } from '../../lib/commercial/contracts-v4.ts';

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > 8_192)
    throw new ApiError(413, 'payload_too_large', 'Requête trop volumineuse.');
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedBody(request, 8192));
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
            'Authorization, Content-Type',
          );
          response.headers.set('Access-Control-Max-Age', '600');
          return response;
        }

        if (!API_ROUTES.has(url.pathname))
          throw new ApiError(404, 'route_not_found', 'Route introuvable.');
        if (request.method !== 'GET' && request.method !== 'POST')
          throw new ApiError(405, 'method_not_allowed', 'Méthode refusée.');
        const source = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const sourceHash = await hashFingerprint(
          source,
          dependencies.deviceFingerprintPepper,
        );
        if (
          !(await dependencies.rateLimiter.allow(
            `ingress:${sourceHash}:${url.pathname}`,
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
            `${profile.id}:${request.method}:${url.pathname}`,
            Date.now(),
          ))
        ) {
          throw new ApiError(429, 'rate_limited', 'Trop de requêtes.');
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
              ? new ApiError(error.status, error.code, error.message)
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
            route: API_ROUTES.has(url.pathname) ? url.pathname : 'unknown',
            status,
            duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
            outcome:
              status >= 500 ? 'unavailable' : status >= 400 ? 'rejected' : 'ok',
            webhook,
          });
        } catch {
          /* Observability failure must not replay a successful mutation. */
        }
      }
    },
  };
}
