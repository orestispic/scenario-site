import type {
  DeviceView,
  MeResponse,
  OfflineGrantPayload,
  PublicConfiguration,
  SignedOfflineGrant,
  UsageView,
} from '../../lib/commercial/contracts-v2.ts';
import type { EntitlementSnapshot } from '../../lib/commercial/contracts.ts';
import type { BillingRepository } from './billing.ts';
import type { StripeGateway } from './stripe.ts';
import type { StripeWebhookVerifier } from './stripeWebhook.ts';
import type { LimiterNamespace } from './distributedRateLimit.ts';
import type { Telemetry } from './observability.ts';
import type { AiProvider } from './aiProvider.ts';
import type { AiQuotaRepository } from './aiQuota.ts';
import type {
  CloudScenarioRepository,
  ScenarioObjectStorage,
} from './cloudSync.ts';
import type { StudioNotificationProvider, StudioRepository } from './studio.ts';
import type {
  CollaborationChannelNamespace,
  RealtimeCollaborationTransport,
} from './realtimeCollaboration.ts';

export interface WorkerEnvironment {
  SCENARIO_ENVIRONMENT: 'test' | 'staging' | 'production';
  API_ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_JWT_AUDIENCE?: string;
  DEVICE_FINGERPRINT_PEPPER: string;
  OFFLINE_GRANT_PRIVATE_JWK: string;
  OFFLINE_GRANT_PUBLIC_JWK: string;
  OFFLINE_GRANT_KEY_ID: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  RATE_LIMITER: LimiterNamespace;
  RATE_LIMIT_KEY_PEPPER: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_WEBHOOK_TOLERANCE_SECONDS?: string;
  ACTIVATION_KEY_PEPPER: string;
  OPENAI_API_KEY: string;
  OPENAI_SHORT_ACTION_MODEL: string;
  OPENAI_PDF_IMPORT_MODEL: string;
  AI_PROVIDER_TIMEOUT_MS?: string;
  AI_SHORT_MAX_BODY_BYTES?: string;
  AI_PDF_MAX_BODY_BYTES?: string;
  AI_MAX_TRANSLATION_SEGMENTS?: string;
  AI_MAX_RESPONSE_BYTES?: string;
  AI_IDEMPOTENCY_PEPPER: string;
  CLOUD_IDEMPOTENCY_PEPPER: string;
  CLOUD_STORAGE_BUCKET?: string;
  CLOUD_MAX_BODY_BYTES?: string;
  CLOUD_DOWNLOAD_TTL_SECONDS?: string;
  STUDIO_INVITATION_PEPPER: string;
  STUDIO_INVITATION_TTL_SECONDS?: string;
  STUDIO_EVENT_PAGE_SIZE?: string;
  STUDIO_TICKET_PEPPER: string;
  STUDIO_REALTIME_CHANNEL?: CollaborationChannelNamespace;
  STUDIO_TICKET_TTL_SECONDS?: string;
  STUDIO_HEARTBEAT_SECONDS?: string;
  STUDIO_IDLE_TIMEOUT_SECONDS?: string;
  STUDIO_MAX_CONNECTION_SECONDS?: string;
  STUDIO_MAX_CONNECTIONS?: string;
  STUDIO_MAX_PROFILE_CONNECTIONS?: string;
  STUDIO_MAX_OPERATION_BYTES?: string;
  STUDIO_MAX_PENDING_EVENTS?: string;
}

export interface AuthenticatedIdentity {
  authUserId: string;
  accessToken: string;
}

export interface ProfileRecord extends MeResponse {
  id: string;
  authUserId: string;
}

export interface EntitlementRecord {
  snapshot: EntitlementSnapshot;
  deviceLimit: number;
  quotaLimits: Record<string, number>;
  quotaPeriods: Record<string, 'month' | 'lifetime'>;
}

export interface ActivateDeviceInput {
  fingerprintHash: string;
  label: string;
  platform: 'windows' | 'macos';
}

export interface CommercialRepository {
  getConfiguration(): Promise<
    Omit<
      PublicConfiguration,
      'environment' | 'offlineGrantPublicKey' | 'offlineGrantKeyId'
    >
  >;
  getProfile(authUserId: string): Promise<ProfileRecord | null>;
  getEntitlements(profileId: string): Promise<EntitlementRecord | null>;
  listDevices(profileId: string): Promise<DeviceView[]>;
  activateDevice(
    profileId: string,
    input: ActivateDeviceInput,
  ): Promise<DeviceView>;
  deactivateDevice(profileId: string, deviceId: string): Promise<void>;
  getUsage(profileId: string): Promise<UsageView[]>;
  logout(accessToken: string): Promise<void>;
  appendAudit(event: {
    profileId: string | null;
    action: string;
    entityType: string;
    entityId?: string;
    requestId: string;
  }): Promise<void>;
}

export interface TokenVerifier {
  verify(authorizationHeader: string | null): Promise<AuthenticatedIdentity>;
}

export interface OfflineGrantSigner {
  readonly keyId: string;
  getPublicKey(): Promise<JsonWebKey>;
  sign(payload: OfflineGrantPayload): Promise<SignedOfflineGrant>;
}

export interface RateLimiter {
  allow(key: string, now: number): Promise<boolean>;
}

export class CommercialRepositoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommercialRepositoryError';
  }
}

export type WorkerDependencies = {
  telemetry?: Telemetry;
  environment: 'test' | 'staging' | 'production';
  allowedOrigins: string[];
  repository: CommercialRepository;
  tokenVerifier: TokenVerifier;
  offlineGrantSigner: OfflineGrantSigner;
  rateLimiter: RateLimiter;
  activationKeyPepper: string;
  billingRepository: BillingRepository;
  stripeGateway: StripeGateway;
  stripeWebhookVerifier: StripeWebhookVerifier;
  aiProvider?: AiProvider;
  aiQuotaRepository?: AiQuotaRepository;
  aiIdempotencyPepper?: string;
  aiPolicy?: {
    shortMaxBodyBytes: number;
    pdfMaxBodyBytes: number;
    maxTranslationSegments: number;
    maxResponseBytes: number;
  };
  cloudRepository?: CloudScenarioRepository;
  scenarioStorage?: ScenarioObjectStorage;
  cloudIdempotencyPepper?: string;
  cloudPolicy?: {
    maximumBodyBytes: number;
    downloadTtlSeconds: number;
  };
  studioRepository?: StudioRepository;
  studioNotifier?: StudioNotificationProvider;
  studioInvitationPepper?: string;
  studioPolicy?: {
    invitationTtlSeconds: number;
    eventPageSize: number;
  };
  realtimeTransport?: RealtimeCollaborationTransport;
};
