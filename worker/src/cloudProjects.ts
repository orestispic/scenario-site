import type { CloudProject } from '../../lib/commercial/contracts-v9.ts';
import type { StudioInvitationView, StudioSpace } from '../../lib/commercial/contracts-v7.ts';
import type { CloudScenarioRepository } from './cloudSync.ts';
import type { LocalStudioRepository, StudioContext } from './studio.ts';
import { CommercialRepositoryError, type WorkerEnvironment } from './types.ts';
import { detachedFetch } from './detachedFetch.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';

export interface CloudProjectRepository {
  list(context: StudioContext): Promise<{ projects: CloudProject[]; receivedInvitations: StudioInvitationView[] }>;
  ensureSharing(input: { context: StudioContext; scenarioId: string; idempotencyHash: string; requestId: string }): Promise<{ studio: StudioSpace; replayed: boolean }>;
  respond(input: { context: StudioContext; invitationId: string; decision: 'accept' | 'decline'; idempotencyHash: string; requestId: string }): Promise<{ responded: true; replayed: boolean }>;
}

export class LocalCloudProjectRepository implements CloudProjectRepository {
  private readonly bases = new Map<string, string>();
  constructor(private readonly cloud: CloudScenarioRepository, private readonly studios: LocalStudioRepository) {}
  async list(context: StudioContext) {
    const scenarios = await this.cloud.list(context);
    let collaborationAllowed = true;
    let invitations: StudioInvitationView[] = [];
    try {
      await this.studios.list(context);
      invitations = await this.studios.receivedInvitations(context);
    }
    catch (error) {
      if (!(error instanceof CommercialRepositoryError) || !['cloud_entitlement_missing', 'studio_entitlement_missing'].includes(error.code)) throw error;
      collaborationAllowed = false;
      invitations = await this.studios.receivedInvitations(context);
    }
    return {
      projects: await Promise.all(scenarios.map(async (scenario): Promise<CloudProject> => {
        const sharing = this.studios.projectSharing(scenario.id, context.profileId);
        const studioId = collaborationAllowed ? sharing.studioId : null;
        const base = studioId ? this.bases.get(scenario.id) ?? (await this.cloud.versions(context, scenario.id)).find((v) => v.parentVersionId === null)?.id ?? null : null;
        return { ...scenario, sharing: sharing.memberCount > 1 ? 'shared' : 'private',
          memberCount: sharing.memberCount, realtimeStudioId: studioId, realtimeBaseVersionId: base,
          canShare: collaborationAllowed && scenario.role === 'owner' && !scenario.deletedAt };
      })),
      receivedInvitations: invitations.filter((i) => Date.parse(i.expiresAt) > Date.now()),
    };
  }
  async ensureSharing(input: Parameters<CloudProjectRepository['ensureSharing']>[0]) {
    const scenario = (await this.cloud.list(input.context)).find((p) => p.id === input.scenarioId && p.role === 'owner' && !p.deletedAt);
    if (!scenario) throw new CommercialRepositoryError(404, 'project_not_found', 'Projet introuvable.');
    const result = await this.studios.create({ ...input, name: scenario.title.slice(0, 120) || 'Projet partagé' });
    if (!result.replayed && scenario.currentVersionId) this.bases.set(scenario.id, scenario.currentVersionId);
    return result;
  }
  async respond(input: Parameters<CloudProjectRepository['respond']>[0]) {
    return this.studios.respondToProjectInvitation(input);
  }
}

export class SupabaseCloudProjectRepository implements CloudProjectRepository {
  constructor(private readonly environment: WorkerEnvironment, private readonly fetcher: typeof fetch = fetch) {}
  list(context: StudioContext) { return this.rpc<Awaited<ReturnType<CloudProjectRepository['list']>>>('list_cloud_projects_v9', { context }); }
  ensureSharing(input: Parameters<CloudProjectRepository['ensureSharing']>[0]) { return this.rpc<Awaited<ReturnType<CloudProjectRepository['ensureSharing']>>>('ensure_project_sharing_v9', input); }
  respond(input: Parameters<CloudProjectRepository['respond']>[0]) { return this.rpc<Awaited<ReturnType<CloudProjectRepository['respond']>>>('respond_project_invitation_v9', input); }
  private async rpc<T>(name: string, input: { context: StudioContext; [key: string]: unknown }): Promise<T> {
    const { context, ...rest } = input;
    const body = Object.fromEntries(Object.entries({ ...context, ...rest }).map(([key, value]) => [`p_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`, value]));
    const response = await detachedFetch(this.fetcher, `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { ...supabaseAdminHeaders(this.environment), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      const code = ['contact_required', 'client_update_required', 'cloud_entitlement_missing', 'cloud_device_inactive', 'studio_device_inactive', 'studio_entitlement_missing', 'studio_not_found', 'project_not_found', 'invitation_expired', 'invitation_not_pending', 'studio_idempotency_conflict', 'last_owner_required'].find((v) => text.includes(v));
      throw new CommercialRepositoryError(code === 'client_update_required' ? 426 : code?.endsWith('not_found') ? 404 : code === 'contact_required' || code?.endsWith('missing') || code?.endsWith('inactive') ? 403 : code ? 409 : 503, code ?? 'projects_unavailable', 'Projet cloud indisponible. Réessayez ou vérifiez votre accès.');
    }
    return response.json() as Promise<T>;
  }
}
