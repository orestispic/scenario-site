import type { CloudProject } from '../../lib/commercial/contracts-v9.ts';
import { seedMetadata, metadataFromRegisters } from '../../lib/commercial/contracts-v10.ts';
import { mergeCollaborationSnapshot } from './collaborationLedger.ts';
import type { CollaborationSnapshotArtifact } from './realtimeCollaboration.ts';
import type { ScenarioObjectStorage } from './cloudSync.ts';
import type { CloudAccessContext } from './cloudSync.ts';
import { CommercialRepositoryError, type WorkerEnvironment } from './types.ts';
import { detachedFetch } from './detachedFetch.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';

export interface CloudProjectVersion {
  id: string; projectId: string; name: string; revision: number; createdAt: string;
  deletedAt: string | null; sourceVersionId: string | null; project: CloudProject;
}
export type VersionCommand = { action: 'duplicate' | 'blank' | 'rename' | 'delete' | 'restore'; operationId: string;
  name?: string; sourceVersionId?: string; versionId?: string; expectedRevision?: number };
export interface ProjectBranchRepository {
  readDocument(context: CloudAccessContext, scenarioId: string): Promise<Record<string, unknown>>;
  list(context: CloudAccessContext, projectId: string, requestId: string): Promise<{ versions: CloudProjectVersion[] }>;
  change(context: CloudAccessContext, projectId: string, command: VersionCommand, requestId: string): Promise<{ version: CloudProjectVersion; replayed: boolean }>;
}
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function readVersionCommand(value: unknown): VersionCommand {
  const fail = (): never => { throw new CommercialRepositoryError(400, 'branch_invalid', 'Action sur la version invalide.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>, create = v.action === 'duplicate' || v.action === 'blank';
  if (!['duplicate','blank','rename','delete','restore'].includes(String(v.action)) || !uuid(v.operationId)) return fail();
  const keys = ['action','operationId',...(create ? (v.action === 'duplicate' ? ['name','sourceVersionId'] : ['name']) : ['versionId','expectedRevision',...(v.action === 'rename' ? ['name'] : [])])];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))) return fail();
  if (keys.includes('name') && (typeof v.name !== 'string' || !v.name.trim() || v.name.trim().length > 80)) return fail();
  if (v.action === 'duplicate' && !uuid(v.sourceVersionId)) return fail();
  if (!create && (!uuid(v.versionId) || !Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 1)) return fail();
  return Object.fromEntries(keys.map(key => [key, key === 'name' ? String(v[key]).trim() : v[key]])) as unknown as VersionCommand;
}
const messages: Record<string,string> = {
  branch_name_conflict: 'Une version porte déjà ce nom.', branch_revision_conflict: 'Cette version a changé ailleurs. Actualisez la liste avant de réessayer.',
  branch_source_changed: 'La version source vient de changer. Réessayez pour copier son contenu à jour.',
  branch_last_version: 'La dernière version du projet ne peut pas être supprimée.', branch_owner_required: 'Seul le propriétaire peut supprimer ou restaurer une version.',
  branch_write_forbidden: 'Un lecteur ne peut pas modifier les versions.', branch_limit: 'La limite de versions de ce projet est atteinte.',
  branch_idempotency_conflict: 'Cette demande a déjà été utilisée pour une autre action.', branch_invalid: 'Version invalide.',
  branch_not_found: 'Version introuvable.', project_not_found: 'Projet introuvable.', cloud_device_inactive: 'Cet appareil n’est pas autorisé.',
  cloud_entitlement_missing: 'Votre offre ne donne pas accès aux projets cloud.', client_update_required: 'Une mise à jour de Senario est nécessaire.',
};
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(b => b.toString(16).padStart(2,'0')).join('');
interface BranchRpcResponse {
  versions?: CloudProjectVersion[]; version?: CloudProjectVersion; replayed?: boolean;
  source?: { sizeBytes: number; checksum: string; storageKey: string; entries: CollaborationSnapshotArtifact['entries']; registers: ReturnType<typeof seedMetadata> | null; stamp: unknown } | null;
}

export class SupabaseProjectBranchRepository implements ProjectBranchRepository {
  constructor(private readonly environment: WorkerEnvironment, private readonly storage: ScenarioObjectStorage, private readonly fetcher: typeof fetch = fetch) {}
  async readDocument(context: CloudAccessContext, scenarioId: string): Promise<Record<string, unknown>> {
    const read = async () => {
      const response = await detachedFetch(this.fetcher, `${this.environment.SUPABASE_URL.replace(/\/$/,'')}/rest/v1/rpc/read_project_document_v16`, {
        method:'POST', headers:{...supabaseAdminHeaders(this.environment),'Content-Type':'application/json'},
        body:JSON.stringify({p_profile_id:context.profileId,p_fingerprint_hash:context.fingerprintHash,p_platform:context.platform,p_client_version:context.clientVersion,p_scenario_id:scenarioId}),
      });
      if (!response.ok) {
        const detail = await response.text();
        const code = Object.keys(messages).find(key => detail.includes(key)) ?? (detail.includes('not_found') ? 'project_not_found' : 'document_unavailable');
        throw new CommercialRepositoryError(code === 'client_update_required' ? 426 : code.includes('not_found') ? 404 : code.includes('missing') || code.includes('inactive') ? 403 : 503, code, 'Document indisponible. Vérifiez votre accès puis réessayez.');
      }
      return (await response.json() as BranchRpcResponse).source;
    };
    const source = await read();
    if (!source || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 2 || source.sizeBytes > 4194304)
      throw new CommercialRepositoryError(409,'branch_invalid','Source invalide.');
    const bytes = await this.storage.get(source.storageKey);
    if (bytes.length !== source.sizeBytes || await hash(bytes) !== source.checksum)
      throw new CommercialRepositoryError(409,'branch_invalid','Intégrité de la source invalide.');
    const document = JSON.parse(new TextDecoder().decode(mergeCollaborationSnapshot(bytes, {
      snapshotId:'',versionId:'',parentVersionId:'',channelCursor:0,operationIds:[],entries:source.entries,
    }))) as Record<string,unknown>;
    if (source.registers) Object.assign(document,metadataFromRegisters(source.registers));
    seedMetadata(document);
    if (new TextEncoder().encode(JSON.stringify(document)).length > 33554432)
      throw new CommercialRepositoryError(413,'document_too_large','Le document est trop volumineux pour être téléchargé.');
    // Access can be revoked while object storage is loading. Recheck before delivery.
    await read();
    return document;
  }
  async list(context: CloudAccessContext, projectId: string, requestId: string) {
    const result = await this.rpc(context,projectId,{ action: 'list' },null,null,requestId);
    if (!Array.isArray(result.versions)) throw new CommercialRepositoryError(503,'branches_unavailable','Liste des versions indisponible.');
    return { versions: result.versions };
  }
  async change(context: CloudAccessContext, projectId: string, command: VersionCommand, requestId: string) {
    command = readVersionCommand(command);
    const fingerprint = await hash(new TextEncoder().encode(JSON.stringify(command)));
    const prepared = await this.rpc(context,projectId,command,fingerprint,null,requestId);
    if (prepared.version) return { version: prepared.version, replayed: prepared.replayed === true };
    let document: Record<string, unknown>, stamp: unknown = null;
    if (command.action === 'duplicate') {
      const source = prepared.source;
      if (!source || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 2 || source.sizeBytes > 4194304) throw new CommercialRepositoryError(409,'branch_invalid','Source invalide.');
      const bytes = await this.storage.get(source.storageKey);
      if (bytes.length !== source.sizeBytes || await hash(bytes) !== source.checksum) throw new CommercialRepositoryError(409,'branch_invalid','Intégrité de la source invalide.');
      const merged = mergeCollaborationSnapshot(bytes, { snapshotId: '', versionId: '', parentVersionId: '', channelCursor: 0, operationIds: [], entries: source.entries });
      document = JSON.parse(new TextDecoder().decode(merged));
      if (source.registers) Object.assign(document, metadataFromRegisters(source.registers));
      stamp = source.stamp;
    } else if (command.action === 'blank') {
      document = { formatVersion: 1, title: 'Sans titre', content: { type: 'doc', content: [{ type: 'paragraph', attrs: { scenarioType: 'SCENE_HEADING', blockId: crypto.randomUUID() } }] },
        characters: [], locations: [], times: [], coverPage: {}, coverPageHidden: false, comments: [] };
    } else throw new CommercialRepositoryError(503,'branches_unavailable','Réponse du serveur incomplète.');
    document.savedAt = new Date().toISOString();
    // Reuse the strict metadata validation; never flatten unknown comments/cover fields.
    seedMetadata(document);
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    if (bytes.length > 4194304) throw new CommercialRepositoryError(413,'branch_too_large','Cette version est trop volumineuse pour le cloud.');
    const checksum = await hash(bytes), storageKey = `branches/${projectId}/${crypto.randomUUID()}.scenario`;
    await this.storage.put({ key: storageKey, bytes, checksum, contentType: 'application/vnd.scenario+json' });
    // CAS rejects a changed source or revoked access. Failed commits only leave an
    // unreferenced object; no existing document or version is ever overwritten.
    const result = await this.rpc(context,projectId,command,fingerprint,{ storageKey,checksum,sizeBytes:bytes.length,stamp },requestId);
    if (!result.version) throw new CommercialRepositoryError(503,'branches_unavailable','Confirmation de la version indisponible. Réessayez la même demande.');
    return { version: result.version, replayed: result.replayed === true };
  }
  private async rpc(context: CloudAccessContext, projectId: string, command: object, fingerprint: string|null, artifact: unknown, requestId: string): Promise<BranchRpcResponse> {
    const response = await detachedFetch(this.fetcher,`${this.environment.SUPABASE_URL.replace(/\/$/,'')}/rest/v1/rpc/project_branches_v14`,{
      method:'POST', headers:{...supabaseAdminHeaders(this.environment),'Content-Type':'application/json'},
      body:JSON.stringify({p_profile_id:context.profileId,p_fingerprint_hash:context.fingerprintHash,p_platform:context.platform,p_client_version:context.clientVersion,p_project_id:projectId,p_command:command,p_fingerprint:fingerprint,p_artifact:artifact,p_request_id:requestId}),
    });
    if (!response.ok) {
      const text = await response.text(), code = Object.keys(messages).find(code => text.includes(code));
      const status = code === 'client_update_required' ? 426 : code?.includes('not_found') ? 404 : code?.includes('forbidden') || code?.includes('required') || code?.includes('missing') || code?.includes('inactive') ? 403 : code === 'branch_invalid' ? 400 : code ? 409 : 503;
      throw new CommercialRepositoryError(status,code ?? 'branches_unavailable',code ? messages[code] : 'Versions cloud indisponibles. Réessayez.');
    }
    return response.json() as Promise<BranchRpcResponse>;
  }
}
