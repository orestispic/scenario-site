import type {
  StudioDetailResponse,
  StudioEventChannel,
  StudioEventType,
  StudioEventView,
  StudioInvitationView,
  StudioMembershipView,
  StudioPresenceProvider,
  StudioRole,
  StudioSpace,
} from '../../lib/commercial/contracts-v7.ts';
import type { LocalTestRepository } from './localTestRepository.ts';
import type {
  CloudAccessContext,
  CloudScenarioRepository,
} from './cloudSync.ts';
import type { WorkerEnvironment } from './types.ts';
import { CommercialRepositoryError } from './types.ts';

export interface StudioContext extends CloudAccessContext {
  emailHash: string;
  displayName: string;
}
export interface StudioNotification {
  invitationId: string;
  recipientEmailHash: string;
  token: string;
  expiresAt: string;
}
export interface StudioNotificationProvider {
  deliver(notification: StudioNotification): Promise<void>;
  developmentToken?(
    invitationId: string,
    recipientEmailHash: string,
  ): string | undefined;
}
export class DeterministicLocalStudioNotifier implements StudioNotificationProvider {
  private readonly deliveries = new Map<string, StudioNotification>();
  async deliver(notification: StudioNotification): Promise<void> {
    this.deliveries.set(
      notification.invitationId,
      structuredClone(notification),
    );
  }
  developmentToken(invitationId: string, recipientEmailHash: string) {
    const value = this.deliveries.get(invitationId);
    return value?.recipientEmailHash === recipientEmailHash
      ? value.token
      : undefined;
  }
  clear(invitationId: string): void {
    this.deliveries.delete(invitationId);
  }
}
export class NoopStudioPresence implements StudioPresenceProvider {
  async join(): Promise<void> {}
  async leave(): Promise<void> {}
}
export class NoopStudioChannel implements StudioEventChannel {
  async publish(): Promise<void> {}
}

export interface StudioRepository extends StudioEventChannel {
  authorizeRealtime(
    context: StudioContext,
    studioId: string,
    write: boolean,
  ): Promise<{ studioId: string; scenarioId: string; role: StudioRole }>;
  list(context: StudioContext): Promise<StudioSpace[]>;
  detail(
    context: StudioContext,
    studioId: string,
  ): Promise<Omit<StudioDetailResponse, 'contractVersion' | 'request_id'>>;
  receivedInvitations(context: StudioContext): Promise<StudioInvitationView[]>;
  create(input: {
    context: StudioContext;
    scenarioId: string;
    name: string;
    idempotencyHash: string;
    requestId: string;
  }): Promise<{ studio: StudioSpace; replayed: boolean }>;
  invite(input: {
    context: StudioContext;
    studioId: string;
    recipientEmailHash: string;
    recipientMasked: string;
    role: Exclude<StudioRole, 'owner'>;
    tokenHash: string;
    expiresAt: string;
    idempotencyHash: string;
    requestId: string;
  }): Promise<{ invitation: StudioInvitationView; replayed: boolean }>;
  accept(input: {
    context: StudioContext;
    tokenHash: string;
    idempotencyHash: string;
    requestId: string;
  }): Promise<{ membership: StudioMembershipView; replayed: boolean }>;
  decline(input: {
    context: StudioContext;
    tokenHash: string;
    idempotencyHash: string;
    requestId: string;
  }): Promise<{ invitation: StudioInvitationView; replayed: boolean }>;
  revokeInvitation(input: {
    context: StudioContext;
    studioId: string;
    invitationId: string;
    idempotencyHash: string;
    requestId: string;
  }): Promise<{ invitation: StudioInvitationView; replayed: boolean }>;
  changeRole(input: {
    context: StudioContext;
    studioId: string;
    profileId: string;
    role: StudioRole;
    idempotencyHash: string;
    requestId: string;
  }): Promise<{ membership: StudioMembershipView; replayed: boolean }>;
  removeMember(input: {
    context: StudioContext;
    studioId: string;
    profileId: string;
    idempotencyHash: string;
    requestId: string;
  }): Promise<{ membership: StudioMembershipView; replayed: boolean }>;
  events(
    context: StudioContext,
    studioId: string,
    after: number,
    limit: number,
  ): Promise<{
    events: StudioEventView[];
    nextCursor: number;
    hasMore: boolean;
  }>;
  publishScenarioVersion(input: {
    scenarioId: string;
    versionId: string;
    requestId: string;
  }): Promise<void>;
}

type StoredStudio = StudioSpace & { ownerId: string };
type StoredInvitation = StudioInvitationView & {
  recipientEmailHash: string;
  tokenHash: string;
};

function hasRight(
  record: Awaited<ReturnType<LocalTestRepository['getEntitlements']>>,
  code: string,
) {
  return Boolean(
    record?.snapshot.entitlements.some(
      (item) => item.code === code && item.enabled,
    ),
  );
}

export class LocalStudioRepository implements StudioRepository {
  private readonly studios = new Map<string, StoredStudio>();
  private readonly members = new Map<
    string,
    Map<string, StudioMembershipView>
  >();
  private readonly invitations = new Map<string, StoredInvitation>();
  readonly membershipJournal: StudioMembershipView[] = [];
  readonly eventJournal: StudioEventView[] = [];
  private readonly replay = new Map<
    string,
    { fingerprint: string; value: unknown }
  >();
  private cursor = 0;

  constructor(
    private readonly commercial: LocalTestRepository,
    private readonly cloud: CloudScenarioRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async authorizeRealtime(
    context: StudioContext,
    studioId: string,
    write: boolean,
  ) {
    const role = await this.requireRole(
      context,
      studioId,
      write ? ['owner', 'editor'] : undefined,
    );
    const studio = this.requireStudio(studioId);
    return { studioId, scenarioId: studio.scenarioId, role };
  }

  async list(context: StudioContext): Promise<StudioSpace[]> {
    await this.authorize(context);
    return [...this.studios.values()]
      .filter((item) => this.role(item.id, context.profileId))
      .map((item) => this.publicStudio(item, context.profileId));
  }
  async detail(context: StudioContext, studioId: string) {
    await this.requireRole(context, studioId);
    const studio = this.requireStudio(studioId);
    return {
      studio: this.publicStudio(studio, context.profileId),
      members: [...(this.members.get(studioId)?.values() ?? [])]
        .filter((item) => item.status === 'active')
        .map((item) => structuredClone(item)),
      invitations:
        this.role(studioId, context.profileId) === 'owner'
          ? [...this.invitations.values()]
              .filter((item) => item.studioId === studioId)
              .map((item) => this.publicInvitation(item))
          : [],
    };
  }
  async receivedInvitations(context: StudioContext) {
    await this.authorize(context);
    return [...this.invitations.values()]
      .filter(
        (item) =>
          item.recipientEmailHash === context.emailHash &&
          item.status === 'pending',
      )
      .map((item) => this.publicInvitation(item));
  }
  async create(input: Parameters<StudioRepository['create']>[0]) {
    const scenarios = await this.authorize(input.context);
    return this.idempotent(
      input.context.profileId,
      input.idempotencyHash,
      `create:${input.scenarioId}:${input.name}`,
      () => {
        const existing = [...this.studios.values()].find(
          (item) => item.scenarioId === input.scenarioId,
        );
        if (existing)
          return {
            studio: this.publicStudio(existing, input.context.profileId),
            replayed: true,
          };
        const scenario = scenarios.find((item) => item.id === input.scenarioId);
        if (!scenario || scenario.role !== 'owner' || scenario.deletedAt)
          throw new CommercialRepositoryError(
            404,
            'studio_scenario_not_found',
            'Studio introuvable.',
          );
        const createdAt = new Date(this.now()).toISOString();
        const studio: StoredStudio = {
          id: crypto.randomUUID(),
          scenarioId: input.scenarioId,
          name: input.name,
          ownerId: input.context.profileId,
          role: 'owner',
          revision: 1,
          createdAt,
          updatedAt: createdAt,
        };
        this.studios.set(studio.id, studio);
        const owner = this.membership(
          studio.id,
          input.context.profileId,
          input.context.displayName,
          'owner',
          'active',
          1,
        );
        this.members.set(studio.id, new Map([[owner.profileId, owner]]));
        this.membershipJournal.push(structuredClone(owner));
        this.appendEvent(studio, 'studio.created', studio.id);
        return {
          studio: this.publicStudio(studio, input.context.profileId),
          replayed: false,
        };
      },
    );
  }
  private async authorize(context: StudioContext) {
    await this.cloud.authorize(context);
    const entitlements = await this.commercial.getEntitlements(
      context.profileId,
    );
    if (!hasRight(entitlements, 'studio_collaboration'))
      throw new CommercialRepositoryError(
        403,
        'studio_entitlement_missing',
        'Collaboration Studio non autorisée.',
      );
    return this.cloud.list(context);
  }
  async invite(input: Parameters<StudioRepository['invite']>[0]) {
    await this.requireOwner(input.context, input.studioId);
    return this.idempotent(
      input.context.profileId,
      input.idempotencyHash,
      `invite:${input.studioId}:${input.recipientEmailHash}:${input.role}`,
      () => {
        if (
          [...this.invitations.values()].some(
            (item) => item.tokenHash === input.tokenHash,
          )
        )
          throw new CommercialRepositoryError(
            409,
            'invitation_token_conflict',
            'Invitation indisponible.',
          );
        const createdAt = new Date(this.now()).toISOString();
        const invitation: StoredInvitation = {
          id: crypto.randomUUID(),
          studioId: input.studioId,
          recipient: input.recipientMasked,
          recipientEmailHash: input.recipientEmailHash,
          tokenHash: input.tokenHash,
          role: input.role,
          status: 'pending',
          expiresAt: input.expiresAt,
          createdAt,
        };
        this.invitations.set(invitation.id, invitation);
        this.bump(input.studioId, 'invitation.created', invitation.id);
        return {
          invitation: this.publicInvitation(invitation),
          replayed: false,
        };
      },
    );
  }
  async accept(input: Parameters<StudioRepository['accept']>[0]) {
    await this.authorize(input.context);
    return this.idempotent(
      input.context.profileId,
      input.idempotencyHash,
      `accept:${input.tokenHash}`,
      () => {
        const invitation = this.findToken(input.tokenHash);
        this.assertInvitationUsable(invitation, input.context.emailHash);
        invitation.status = 'accepted';
        const studio = this.requireStudio(invitation.studioId);
        const previous = this.members
          .get(studio.id)
          ?.get(input.context.profileId);
        const membership = this.membership(
          studio.id,
          input.context.profileId,
          input.context.displayName,
          invitation.role,
          'active',
          (previous?.revision ?? 0) + 1,
        );
        this.members.get(studio.id)!.set(input.context.profileId, membership);
        this.membershipJournal.push(structuredClone(membership));
        this.bump(studio.id, 'invitation.accepted', invitation.id);
        this.cloudMembership(
          studio.scenarioId,
          input.context.profileId,
          invitation.role,
        );
        return { membership: structuredClone(membership), replayed: false };
      },
    );
  }
  async decline(input: Parameters<StudioRepository['decline']>[0]) {
    await this.authorize(input.context);
    return this.idempotent(
      input.context.profileId,
      input.idempotencyHash,
      `decline:${input.tokenHash}`,
      () => {
        const invitation = this.findToken(input.tokenHash);
        this.assertInvitationUsable(invitation, input.context.emailHash);
        invitation.status = 'declined';
        this.bump(invitation.studioId, 'invitation.declined', invitation.id);
        return {
          invitation: this.publicInvitation(invitation),
          replayed: false,
        };
      },
    );
  }
  async revokeInvitation(
    input: Parameters<StudioRepository['revokeInvitation']>[0],
  ) {
    await this.requireOwner(input.context, input.studioId);
    return this.idempotent(
      input.context.profileId,
      input.idempotencyHash,
      `revoke:${input.studioId}:${input.invitationId}`,
      () => {
        const invitation = this.invitations.get(input.invitationId);
        if (!invitation || invitation.studioId !== input.studioId)
          throw this.notFound();
        if (invitation.status !== 'pending')
          throw new CommercialRepositoryError(
            409,
            'invitation_not_pending',
            'Invitation indisponible.',
          );
        invitation.status = 'revoked';
        this.bump(input.studioId, 'invitation.revoked', invitation.id);
        return {
          invitation: this.publicInvitation(invitation),
          replayed: false,
        };
      },
    );
  }
  async changeRole(input: Parameters<StudioRepository['changeRole']>[0]) {
    await this.requireOwner(input.context, input.studioId);
    return this.idempotent(
      input.context.profileId,
      input.idempotencyHash,
      `role:${input.studioId}:${input.profileId}:${input.role}`,
      () => {
        const studio = this.requireStudio(input.studioId);
        const old = this.members.get(studio.id)?.get(input.profileId);
        if (!old || old.status !== 'active') throw this.notFound();
        if (
          input.profileId === input.context.profileId &&
          old.role !== input.role
        )
          throw new CommercialRepositoryError(
            403,
            'self_role_change_forbidden',
            'Auto-élévation refusée.',
          );
        if (
          old.role === 'owner' &&
          input.role !== 'owner' &&
          this.ownerCount(studio.id) === 1
        )
          throw new CommercialRepositoryError(
            409,
            'last_owner_required',
            'Le dernier owner doit être conservé.',
          );
        const membership = this.membership(
          studio.id,
          old.profileId,
          old.displayName,
          input.role,
          'active',
          old.revision + 1,
        );
        this.members.get(studio.id)!.set(old.profileId, membership);
        this.membershipJournal.push(structuredClone(membership));
        this.bump(studio.id, 'membership.role_changed', old.profileId);
        if (input.role !== 'owner')
          this.cloudMembership(studio.scenarioId, old.profileId, input.role);
        return { membership: structuredClone(membership), replayed: false };
      },
    );
  }
  async removeMember(input: Parameters<StudioRepository['removeMember']>[0]) {
    await this.requireOwner(input.context, input.studioId);
    return this.idempotent(
      input.context.profileId,
      input.idempotencyHash,
      `remove:${input.studioId}:${input.profileId}`,
      () => {
        const studio = this.requireStudio(input.studioId);
        const old = this.members.get(studio.id)?.get(input.profileId);
        if (!old || old.status !== 'active') throw this.notFound();
        if (old.role === 'owner' && this.ownerCount(studio.id) === 1)
          throw new CommercialRepositoryError(
            409,
            'last_owner_required',
            'Le dernier owner doit être conservé.',
          );
        const membership = this.membership(
          studio.id,
          old.profileId,
          old.displayName,
          old.role,
          'revoked',
          old.revision + 1,
        );
        this.members.get(studio.id)!.set(old.profileId, membership);
        this.membershipJournal.push(structuredClone(membership));
        this.bump(studio.id, 'membership.removed', old.profileId);
        (
          this.cloud as {
            removeMembership?: (scenarioId: string, profileId: string) => void;
          }
        ).removeMembership?.(studio.scenarioId, old.profileId);
        return { membership: structuredClone(membership), replayed: false };
      },
    );
  }
  async events(
    context: StudioContext,
    studioId: string,
    after: number,
    limit: number,
  ) {
    await this.requireRole(context, studioId);
    const all = this.eventJournal.filter(
      (item) => item.studioId === studioId && item.cursor > after,
    );
    const events = all.slice(0, limit).map((item) => structuredClone(item));
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
      hasMore: all.length > events.length,
    };
  }
  async publish(event: StudioEventView): Promise<void> {
    this.eventJournal.push(structuredClone(event));
  }
  async publishScenarioVersion(input: {
    scenarioId: string;
    versionId: string;
    requestId: string;
  }): Promise<void> {
    for (const studio of this.studios.values())
      if (studio.scenarioId === input.scenarioId)
        this.bump(studio.id, 'scenario.version_created', input.versionId);
  }
  private async requireRole(
    context: StudioContext,
    studioId: string,
    roles?: StudioRole[],
  ) {
    const scenarios = await this.authorize(context);
    const role = this.role(studioId, context.profileId);
    if (!role || (roles && !roles.includes(role))) throw this.notFound();
    const studio = this.requireStudio(studioId);
    const scenario = scenarios.find((item) => item.id === studio.scenarioId);
    if (!scenario || scenario.deletedAt) throw this.notFound();
    return role;
  }
  private requireOwner(context: StudioContext, studioId: string) {
    return this.requireRole(context, studioId, ['owner']);
  }
  private role(studioId: string, profileId: string): StudioRole | null {
    const value = this.members.get(studioId)?.get(profileId);
    return value?.status === 'active' ? value.role : null;
  }
  private requireStudio(id: string) {
    const value = this.studios.get(id);
    if (!value) throw this.notFound();
    return value;
  }
  private findToken(hash: string) {
    const value = [...this.invitations.values()].find(
      (item) => item.tokenHash === hash,
    );
    if (!value) throw this.notFound();
    return value;
  }
  private assertInvitationUsable(
    invitation: StoredInvitation,
    emailHash: string,
  ) {
    if (invitation.recipientEmailHash !== emailHash) throw this.notFound();
    if (invitation.status !== 'pending')
      throw new CommercialRepositoryError(
        409,
        'invitation_not_pending',
        'Invitation indisponible.',
      );
    if (Date.parse(invitation.expiresAt) <= this.now()) {
      invitation.status = 'expired';
      throw new CommercialRepositoryError(
        410,
        'invitation_expired',
        'Invitation expirée.',
      );
    }
  }
  private publicStudio(item: StoredStudio, profileId: string): StudioSpace {
    const { ownerId: _ownerId, ...value } = item;
    return { ...structuredClone(value), role: this.role(item.id, profileId)! };
  }
  private publicInvitation(item: StoredInvitation): StudioInvitationView {
    const {
      tokenHash: _tokenHash,
      recipientEmailHash: _emailHash,
      ...value
    } = item;
    return structuredClone(value);
  }
  private membership(
    studioId: string,
    profileId: string,
    displayName: string,
    role: StudioRole,
    status: 'active' | 'revoked',
    revision: number,
  ): StudioMembershipView {
    return {
      studioId,
      profileId,
      displayName,
      role,
      status,
      revision,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }
  private bump(studioId: string, type: StudioEventType, entityId: string) {
    const studio = this.requireStudio(studioId);
    studio.revision += 1;
    studio.updatedAt = new Date(this.now()).toISOString();
    this.appendEvent(studio, type, entityId);
  }
  private appendEvent(
    studio: StoredStudio,
    type: StudioEventType,
    entityId: string,
  ) {
    this.eventJournal.push({
      studioId: studio.id,
      cursor: ++this.cursor,
      revision: studio.revision,
      type,
      entityId,
      createdAt: new Date(this.now()).toISOString(),
    });
  }
  private ownerCount(studioId: string) {
    return [...(this.members.get(studioId)?.values() ?? [])].filter(
      (item) => item.status === 'active' && item.role === 'owner',
    ).length;
  }
  private cloudMembership(
    scenarioId: string,
    profileId: string,
    role: Exclude<StudioRole, 'owner'>,
  ) {
    (
      this.cloud as {
        addMembership?: (
          scenarioId: string,
          profileId: string,
          role: 'editor' | 'viewer',
        ) => void;
      }
    ).addMembership?.(scenarioId, profileId, role);
  }
  private notFound() {
    return new CommercialRepositoryError(
      404,
      'studio_not_found',
      'Studio introuvable.',
    );
  }
  private idempotent<T extends { replayed: boolean }>(
    profileId: string,
    key: string,
    fingerprint: string,
    create: () => T,
  ): T {
    const mapKey = `${profileId}:${key}`;
    const old = this.replay.get(mapKey);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new CommercialRepositoryError(
          409,
          'studio_idempotency_conflict',
          'Clé déjà utilisée.',
        );
      return { ...(structuredClone(old.value) as T), replayed: true };
    }
    const value = create();
    this.replay.set(mapKey, { fingerprint, value: structuredClone(value) });
    return value;
  }
}

/** Production adapter: all decisions/mutations remain in SECURITY DEFINER RPCs. */
export class SupabaseStudioRepository implements StudioRepository {
  constructor(
    private readonly environment: WorkerEnvironment,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async authorizeRealtime(
    context: StudioContext,
    studioId: string,
    write: boolean,
  ) {
    const detail = await this.detail(context, studioId);
    if (write && detail.studio.role === 'viewer')
      throw new CommercialRepositoryError(
        403,
        'studio_write_forbidden',
        'Écriture Studio refusée.',
      );
    return {
      studioId,
      scenarioId: detail.studio.scenarioId,
      role: detail.studio.role,
    };
  }
  list(context: StudioContext) {
    return this.rpc<StudioSpace[]>('list_studios', this.context(context));
  }
  async detail(context: StudioContext, studioId: string) {
    return this.rpc<
      Omit<StudioDetailResponse, 'contractVersion' | 'request_id'>
    >('get_studio_detail', { ...this.context(context), p_studio_id: studioId });
  }
  receivedInvitations(context: StudioContext) {
    return this.rpc<StudioInvitationView[]>(
      'list_received_studio_invitations',
      this.context(context),
    );
  }
  create(input: Parameters<StudioRepository['create']>[0]) {
    return this.mutate<{ studio: StudioSpace; replayed: boolean }>(
      'create_studio',
      input,
    );
  }
  invite(input: Parameters<StudioRepository['invite']>[0]) {
    return this.mutate<{ invitation: StudioInvitationView; replayed: boolean }>(
      'create_studio_invitation',
      input,
    );
  }
  accept(input: Parameters<StudioRepository['accept']>[0]) {
    return this.mutate<{ membership: StudioMembershipView; replayed: boolean }>(
      'accept_studio_invitation',
      input,
    );
  }
  decline(input: Parameters<StudioRepository['decline']>[0]) {
    return this.mutate<{ invitation: StudioInvitationView; replayed: boolean }>(
      'decline_studio_invitation',
      input,
    );
  }
  revokeInvitation(input: Parameters<StudioRepository['revokeInvitation']>[0]) {
    return this.mutate<{ invitation: StudioInvitationView; replayed: boolean }>(
      'revoke_studio_invitation',
      input,
    );
  }
  changeRole(input: Parameters<StudioRepository['changeRole']>[0]) {
    return this.mutate<{ membership: StudioMembershipView; replayed: boolean }>(
      'change_studio_member_role',
      input,
    );
  }
  removeMember(input: Parameters<StudioRepository['removeMember']>[0]) {
    return this.mutate<{ membership: StudioMembershipView; replayed: boolean }>(
      'remove_studio_member',
      input,
    );
  }
  events(
    context: StudioContext,
    studioId: string,
    after: number,
    limit: number,
  ) {
    return this.rpc<{
      events: StudioEventView[];
      nextCursor: number;
      hasMore: boolean;
    }>('list_studio_events', {
      ...this.context(context),
      p_studio_id: studioId,
      p_after_cursor: after,
      p_limit: limit,
    });
  }
  async publish(): Promise<void> {}
  async publishScenarioVersion(input: {
    scenarioId: string;
    versionId: string;
    requestId: string;
  }) {
    await this.rpc('append_studio_version_event', {
      p_scenario_id: input.scenarioId,
      p_version_id: input.versionId,
      p_request_id: input.requestId,
    });
  }
  private mutate<T>(name: string, input: Record<string, unknown>) {
    const { context, ...rest } = input as { context: StudioContext };
    return this.rpc<T>(name, {
      ...this.context(context),
      ...Object.fromEntries(
        Object.entries(rest).map(([key, value]) => [
          key === 'profileId'
            ? 'p_member_profile_id'
            : `p_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`,
          value,
        ]),
      ),
    });
  }
  private context(value: StudioContext) {
    return {
      p_profile_id: value.profileId,
      p_fingerprint_hash: value.fingerprintHash,
      p_platform: value.platform,
      p_client_version: value.clientVersion,
      p_email_hash: value.emailHash,
      p_display_name: value.displayName,
    };
  }
  private async rpc<T>(name: string, body: unknown): Promise<T> {
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
      const code = [
        'studio_entitlement_missing',
        'studio_device_inactive',
        'client_update_required',
        'studio_not_found',
        'invitation_expired',
        'invitation_not_pending',
        'last_owner_required',
        'self_role_change_forbidden',
        'studio_idempotency_conflict',
      ].find((item) => text.includes(item));
      throw new CommercialRepositoryError(
        code === 'client_update_required'
          ? 426
          : code === 'invitation_expired'
            ? 410
            : code?.includes('not_found')
              ? 404
              : code?.includes('required') ||
                  code?.includes('conflict') ||
                  code?.includes('pending')
                ? 409
                : code?.includes('missing') ||
                    code?.includes('inactive') ||
                    code?.includes('forbidden')
                  ? 403
                  : 503,
        code ?? 'studio_repository_unavailable',
        'Opération Studio refusée.',
      );
    }
    return response.json() as Promise<T>;
  }
}
