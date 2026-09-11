export const COMMERCIAL_CONTRACT_VERSION_V7 = '2026-09-v7';

export type StudioRole = 'owner' | 'editor' | 'viewer';
export type StudioMembershipStatus = 'active' | 'revoked';
export type StudioInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'revoked';

export interface StudioSpace {
  id: string;
  scenarioId: string;
  name: string;
  role: StudioRole;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudioMembershipView {
  studioId: string;
  profileId: string;
  displayName: string;
  role: StudioRole;
  status: StudioMembershipStatus;
  revision: number;
  updatedAt: string;
}

export interface StudioInvitationView {
  id: string;
  studioId: string;
  recipient: string;
  role: Exclude<StudioRole, 'owner'>;
  status: StudioInvitationStatus;
  expiresAt: string;
  createdAt: string;
  /** Present only in the isolated local-test notification adapter; never persisted by clients. */
  developmentToken?: string;
}

export type StudioEventType =
  | 'studio.created'
  | 'invitation.created'
  | 'invitation.accepted'
  | 'invitation.declined'
  | 'invitation.revoked'
  | 'membership.role_changed'
  | 'membership.removed'
  | 'scenario.version_created';

export interface StudioEventView {
  studioId: string;
  cursor: number;
  revision: number;
  type: StudioEventType;
  entityId: string;
  createdAt: string;
}

export interface StudioListResponse {
  contractVersion: '2026-09-v7';
  studios: StudioSpace[];
  receivedInvitations: StudioInvitationView[];
  request_id: string;
}
export interface StudioDetailResponse {
  contractVersion: '2026-09-v7';
  studio: StudioSpace;
  members: StudioMembershipView[];
  invitations: StudioInvitationView[];
  request_id: string;
}
export interface StudioMutationResponse {
  contractVersion: '2026-09-v7';
  studio?: StudioSpace;
  membership?: StudioMembershipView;
  invitation?: StudioInvitationView;
  replayed: boolean;
  request_id: string;
}
export interface StudioEventsResponse {
  contractVersion: '2026-09-v7';
  events: StudioEventView[];
  nextCursor: number;
  hasMore: boolean;
  request_id: string;
}

/** Phase 8 injection point. No presence data is persisted in phase 7. */
export interface StudioPresenceProvider {
  join(studioId: string, profileId: string): Promise<void>;
  leave(studioId: string, profileId: string): Promise<void>;
}
/** Delivery is best-effort after the authoritative append-only mutation. */
export interface StudioEventChannel {
  publish(event: StudioEventView): Promise<void>;
}
/** Future CRDT/OT payloads must name an explicit base version and never silently merge. */
export interface CollaborativeEditEnvelope {
  studioId: string;
  scenarioId: string;
  baseVersionId: string;
  clientOperationId: string;
  strategy: 'crdt-v1' | 'ot-v1';
  payloadChecksum: string;
}
