import type { ContactListResponse, ContactRequestView, ContactView } from '../../lib/commercial/contracts-v15.ts';
import type { LocalTestRepository } from './localTestRepository.ts';
import type { StudioContext } from './studio.ts';
import { CommercialRepositoryError, type WorkerEnvironment } from './types.ts';
import { detachedFetch } from './detachedFetch.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';

export interface ContactRepository {
  list(context: StudioContext): Promise<ContactListResponse>;
  request(input: { context: StudioContext; email: string }): Promise<{ updated: true }>;
  respond(input: { context: StudioContext; requestId: string; decision: 'accept' | 'decline' | 'cancel' }): Promise<{ updated: true }>;
  remove(input: { context: StudioContext; contactProfileId: string }): Promise<{ updated: true }>;
  requireAcceptedEmail(profileId: string, email: string): Promise<string>;
}

type StoredContactRequest = {
  id: string;
  requesterProfileId: string;
  recipientProfileId: string;
  status: 'pending' | 'accepted';
  createdAt: string;
  acceptedAt: string | null;
};

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export class LocalContactRepository implements ContactRepository {
  private readonly requests = new Map<string, StoredContactRequest>();
  constructor(private readonly commercial: LocalTestRepository, private readonly now: () => number = Date.now,
    private readonly onRemoved: (a: string, b: string) => void = () => {}) {}

  hasAccepted(a: string, b: string): boolean {
    return a !== b && [...this.requests.values()].some(item => item.status === 'accepted' &&
      [item.requesterProfileId, item.recipientProfileId].includes(a) && [item.requesterProfileId, item.recipientProfileId].includes(b));
  }

  private authorize(context: StudioContext) {
    if (compareVersions(context.clientVersion, this.commercial.minimumSupportedVersion(context.platform)) < 0)
      throw new CommercialRepositoryError(426, 'client_update_required', 'Mise à jour requise.');
    if (!this.commercial.hasActiveDevice(context.profileId, context.fingerprintHash, context.platform))
      throw new CommercialRepositoryError(403, 'cloud_device_inactive', 'Appareil non autorisé.');
  }
  private person(profileId: string, request: StoredContactRequest): ContactView | ContactRequestView {
    const profile = this.commercial.findProfileById(profileId);
    if (!profile) throw new CommercialRepositoryError(404, 'contact_not_found', 'Compte introuvable.');
    const base = { profileId, displayName: profile.account.displayName || profile.account.email.split('@')[0], email: profile.account.email };
    return request.status === 'accepted'
      ? { ...base, since: request.acceptedAt ?? request.createdAt }
      : { ...base, id: request.id, createdAt: request.createdAt };
  }
  async list(context: StudioContext) {
    this.authorize(context);
    const relevant = [...this.requests.values()].filter((item) => item.requesterProfileId === context.profileId || item.recipientProfileId === context.profileId);
    return {
      contacts: relevant.filter((item) => item.status === 'accepted').map((item) => this.person(item.requesterProfileId === context.profileId ? item.recipientProfileId : item.requesterProfileId, item) as ContactView),
      receivedRequests: relevant.filter((item) => item.status === 'pending' && item.recipientProfileId === context.profileId).map((item) => this.person(item.requesterProfileId, item) as ContactRequestView),
      sentRequests: relevant.filter((item) => item.status === 'pending' && item.requesterProfileId === context.profileId).map((item) => this.person(item.recipientProfileId, item) as ContactRequestView),
    };
  }
  async request(input: Parameters<ContactRepository['request']>[0]) {
    this.authorize(input.context);
    const target = this.commercial.findProfileByEmail(input.email);
    if (!target || target.id === input.context.profileId) throw new CommercialRepositoryError(404, 'contact_not_found', 'Aucun compte Senario ne correspond à cette adresse.');
    const existing = [...this.requests.values()].find((item) =>
      [item.requesterProfileId, item.recipientProfileId].includes(input.context.profileId) &&
      [item.requesterProfileId, item.recipientProfileId].includes(target.id));
    if (existing?.status === 'accepted') throw new CommercialRepositoryError(409, 'contact_already_exists', 'Cette personne est déjà dans vos contacts.');
    if (existing) return { updated: true as const };
    const createdAt = new Date(this.now()).toISOString();
    const request: StoredContactRequest = { id: crypto.randomUUID(), requesterProfileId: input.context.profileId, recipientProfileId: target.id, status: 'pending', createdAt, acceptedAt: null };
    this.requests.set(request.id, request);
    return { updated: true as const };
  }
  async respond(input: Parameters<ContactRepository['respond']>[0]) {
    this.authorize(input.context);
    const request = this.requests.get(input.requestId);
    if (!request || request.status !== 'pending') throw new CommercialRepositoryError(404, 'contact_request_not_found', 'Demande de contact introuvable.');
    if (input.decision === 'cancel') {
      if (request.requesterProfileId !== input.context.profileId) throw new CommercialRepositoryError(403, 'contact_request_forbidden', 'Action refusée.');
      this.requests.delete(request.id);
    } else {
      if (request.recipientProfileId !== input.context.profileId) throw new CommercialRepositoryError(403, 'contact_request_forbidden', 'Action refusée.');
      if (input.decision === 'accept') { request.status = 'accepted'; request.acceptedAt = new Date(this.now()).toISOString(); }
      else this.requests.delete(request.id);
    }
    return { updated: true as const };
  }
  async remove(input: Parameters<ContactRepository['remove']>[0]) {
    this.authorize(input.context);
    if (input.contactProfileId === input.context.profileId) throw new CommercialRepositoryError(404, 'contact_not_found', 'Contact introuvable.');
    const request = [...this.requests.values()].find((item) => item.status === 'accepted' &&
      [item.requesterProfileId, item.recipientProfileId].includes(input.context.profileId) &&
      [item.requesterProfileId, item.recipientProfileId].includes(input.contactProfileId));
    if (!request) throw new CommercialRepositoryError(404, 'contact_not_found', 'Contact introuvable.');
    this.requests.delete(request.id);
    this.onRemoved(input.context.profileId, input.contactProfileId);
    return { updated: true as const };
  }
  async requireAcceptedEmail(profileId: string, email: string) {
    const target = this.commercial.findProfileByEmail(email);
    const accepted = target && this.hasAccepted(profileId, target.id);
    if (!accepted) throw new CommercialRepositoryError(403, 'contact_required', 'Ajoutez cette personne à vos contacts avant de partager un projet.');
    return target!.id;
  }
}

export class SupabaseContactRepository implements ContactRepository {
  constructor(private readonly environment: WorkerEnvironment, private readonly fetcher: typeof fetch = fetch) {}
  list(context: StudioContext) { return this.rpc<ContactListResponse>('list_project_contacts_v15', this.context(context)); }
  request(input: Parameters<ContactRepository['request']>[0]) { return this.rpc<{ updated: true }>('request_project_contact_v15', { ...this.context(input.context), p_email: input.email }); }
  respond(input: Parameters<ContactRepository['respond']>[0]) { return this.rpc<{ updated: true }>('respond_project_contact_v15', { ...this.context(input.context), p_request_id: input.requestId, p_decision: input.decision }); }
  remove(input: Parameters<ContactRepository['remove']>[0]) { return this.rpc<{ updated: true }>('remove_project_contact_v15', { ...this.context(input.context), p_contact_profile_id: input.contactProfileId }); }
  async requireAcceptedEmail(profileId: string, email: string) {
    const result = await this.rpc<{ profileId: string }>('require_project_contact_v15', { p_profile_id: profileId, p_email: email });
    return result.profileId;
  }
  private context(value: StudioContext) {
    return { p_profile_id: value.profileId, p_fingerprint_hash: value.fingerprintHash, p_platform: value.platform, p_client_version: value.clientVersion };
  }
  private async rpc<T>(name: string, body: unknown): Promise<T> {
    const response = await detachedFetch(this.fetcher, `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { ...supabaseAdminHeaders(this.environment), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      const code = ['client_update_required','cloud_device_inactive','contact_not_found','contact_request_not_found','contact_request_forbidden','contact_already_exists','contact_required'].find((item) => text.includes(item));
      throw new CommercialRepositoryError(code === 'client_update_required' ? 426 : code?.includes('not_found') ? 404 : code?.includes('already') ? 409 : code?.includes('inactive') || code?.includes('forbidden') || code === 'contact_required' ? 403 : 503, code ?? 'contacts_unavailable', 'Opération de contact indisponible.');
    }
    return response.json() as Promise<T>;
  }
}
