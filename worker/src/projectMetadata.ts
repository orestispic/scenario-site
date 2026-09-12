import {
  seedMetadata,
  validateMetadataWrite,
  validateRegisters,
  type MetadataState,
  type MetadataWrite,
  type MetadataResponse,
} from '../../lib/commercial/contracts-v10.ts';
import type {
  CloudScenarioRepository,
  ScenarioObjectStorage,
} from './cloudSync.ts';
import type { StudioContext, StudioRepository } from './studio.ts';
import { CommercialRepositoryError, type WorkerEnvironment } from './types.ts';
import { supabaseAdminHeaders } from './supabaseAdmin.ts';
import { detachedFetch } from './detachedFetch.ts';

type Result = Omit<MetadataResponse, 'contractVersion' | 'request_id'>;
type Context = {
  context: StudioContext;
  scenarioId: string;
  requestId: string;
};
export interface ProjectMetadataRepository {
  read(input: Context): Promise<Result>;
  write(input: Context & { write: MetadataWrite }): Promise<Result>;
  forSnapshot(input: Context & { snapshotId: string }): Promise<MetadataState>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function hash(value: Uint8Array | string) {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
async function seed(
  cloud: CloudScenarioRepository,
  storage: ScenarioObjectStorage,
  input: Context,
): Promise<MetadataState> {
  const project = (await cloud.list(input.context)).find(
    (p) => p.id === input.scenarioId && !p.deletedAt,
  );
  if (!project?.currentVersionId)
    throw new CommercialRepositoryError(
      404,
      'project_not_found',
      'Projet indisponible.',
    );
  const version = (await cloud.versions(input.context, input.scenarioId)).find(
    (v) => v.id === project.currentVersionId,
  );
  if (!version || version.sizeBytes > 4194304)
    throw new CommercialRepositoryError(
      409,
      'project_metadata_invalid',
      'Version initiale invalide.',
    );
  const bytes = await storage.get(
    await cloud.storageKey(input.context, input.scenarioId, version.id),
  );
  if (
    bytes.length !== version.sizeBytes ||
    (await hash(bytes)) !== version.checksum
  )
    throw new CommercialRepositoryError(
      409,
      'project_metadata_invalid',
      'Intégrité du projet invalide.',
    );
  let registers;
  try {
    registers = seedMetadata(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new CommercialRepositoryError(
      409,
      'project_metadata_invalid',
      'Les premières pages ou commentaires nécessitent une récupération.',
    );
  }
  return {
    scenarioId: input.scenarioId,
    baseVersionId: version.id,
    revision: 0,
    registers,
  };
}
const current = (state: MetadataState): Result => ({
  state: structuredClone(state),
  status: 'current',
  conflictKeys: [],
  replayed: false,
});

export class LocalProjectMetadataRepository implements ProjectMetadataRepository {
  private states = new Map<string, MetadataState>();
  private operations = new Map<
    string,
    { fingerprint: string; result: Result }
  >();
  private snapshots = new Map<string, MetadataState>();
  private commands: Promise<unknown> = Promise.resolve();
  constructor(
    private cloud: CloudScenarioRepository,
    private storage: ScenarioObjectStorage,
    private studios: StudioRepository,
  ) {}
  private async authorize(input: Context, write = false) {
    const studio = (await this.studios.list(input.context)).find(
      (s) => s.scenarioId === input.scenarioId,
    );
    if (!studio)
      throw new CommercialRepositoryError(
        404,
        'project_not_found',
        'Projet indisponible.',
      );
    await this.studios.authorizeRealtime(input.context, studio.id, write);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.commands.then(work);
    this.commands = next.catch(() => undefined);
    return next;
  }
  read(input: Context) {
    return this.serial(async () => {
      await this.authorize(input);
      let state = this.states.get(input.scenarioId);
      if (!state) {
        state = await seed(this.cloud, this.storage, input);
        this.states.set(input.scenarioId, state);
      }
      return current(state);
    });
  }
  async write(input: Context & { write: MetadataWrite }) {
    validateMetadataWrite(input.write);
    await this.read(input);
    return this.serial(async () => {
      await this.authorize(input, true);
      const key = `${input.context.profileId}:${input.write.operationId}`,
        fingerprint = await hash(
          canonical({ scenarioId: input.scenarioId, ...input.write }),
        );
      const old = this.operations.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new CommercialRepositoryError(
            409,
            'metadata_idempotency_conflict',
            'Requête différente.',
          );
        return { ...structuredClone(old.result), replayed: true };
      }
      const state = structuredClone(this.states.get(input.scenarioId)!);
      const conflictKeys = input.write.changes
        .filter(
          (c) => (state.registers[c.key]?.revision ?? 0) !== c.expectedRevision,
        )
        .map((c) => c.key);
      if (!conflictKeys.length) {
        state.revision++;
        for (const c of input.write.changes)
          state.registers[c.key] = {
            revision: state.revision,
            value: structuredClone(c.value),
          };
        validateRegisters(state.registers);
        this.states.set(input.scenarioId, state);
      }
      const result: Result = {
        state,
        status: conflictKeys.length ? 'conflict' : 'applied',
        conflictKeys,
        replayed: false,
      };
      this.operations.set(key, {
        fingerprint,
        result: structuredClone(result),
      });
      return result;
    });
  }
  async forSnapshot(input: Context & { snapshotId: string }) {
    await this.read(input);
    return this.serial(async () => {
      await this.authorize(input, true);
      const key = `${input.scenarioId}:${input.snapshotId}`;
      const state =
        this.snapshots.get(key) ??
        structuredClone(this.states.get(input.scenarioId)!);
      this.snapshots.set(key, state);
      return structuredClone(state);
    });
  }
}

export class SupabaseProjectMetadataRepository implements ProjectMetadataRepository {
  constructor(
    private environment: WorkerEnvironment,
    private cloud: CloudScenarioRepository,
    private storage: ScenarioObjectStorage,
    private fetcher: typeof fetch = fetch,
  ) {}
  async read(input: Context): Promise<Result> {
    let result = await this.rpc(input);
    if (!result.state) {
      const initial = await seed(this.cloud, this.storage, input);
      result = await this.rpc(input, {
        p_seed_version_id: initial.baseVersionId,
        p_seed: initial.registers,
      });
    }
    if (!result.state)
      throw new CommercialRepositoryError(
        503,
        'project_metadata_unavailable',
        'Métadonnées indisponibles.',
      );
    return result as Result;
  }
  async write(input: Context & { write: MetadataWrite }): Promise<Result> {
    validateMetadataWrite(input.write);
    await this.read(input);
    return this.rpc(input, {
      p_operation_id: input.write.operationId,
      p_changes: input.write.changes,
      p_fingerprint: await hash(
        canonical({ scenarioId: input.scenarioId, ...input.write }),
      ),
    }) as Promise<Result>;
  }
  async forSnapshot(input: Context & { snapshotId: string }) {
    await this.read(input);
    const result = await this.rpc(input, { p_snapshot_id: input.snapshotId });
    if (!result.state)
      throw new CommercialRepositoryError(
        503,
        'project_metadata_unavailable',
        'Métadonnées indisponibles.',
      );
    return result.state;
  }
  private async rpc(
    input: Context,
    extra: Record<string, unknown> = {},
  ): Promise<Omit<Result, 'state'> & { state: MetadataState | null }> {
    const c = input.context;
    const response = await detachedFetch(
      this.fetcher,
      `${this.environment.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/project_metadata_v10`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          ...supabaseAdminHeaders(this.environment),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_profile_id: c.profileId,
          p_fingerprint_hash: c.fingerprintHash,
          p_platform: c.platform,
          p_client_version: c.clientVersion,
          p_scenario_id: input.scenarioId,
          p_request_id: input.requestId,
          p_seed_version_id: null,
          p_seed: null,
          p_operation_id: null,
          p_changes: null,
          p_fingerprint: null,
          p_snapshot_id: null,
          ...extra,
        }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      const code = [
        'client_update_required',
        'studio_device_inactive',
        'cloud_device_inactive',
        'studio_entitlement_missing',
        'cloud_entitlement_missing',
        'studio_not_found',
        'project_not_found',
        'metadata_idempotency_conflict',
        'metadata_seed_stale',
        'project_metadata_invalid',
      ].find((code) => text.includes(code));
      throw new CommercialRepositoryError(
        code === 'client_update_required'
          ? 426
          : code?.endsWith('not_found')
            ? 404
            : code?.endsWith('missing') || code?.endsWith('inactive')
              ? 403
              : code
                ? 409
                : 503,
        code ?? 'project_metadata_unavailable',
        'Premières pages ou commentaires indisponibles. Votre copie locale reste conservée.',
      );
    }
    return response.json();
  }
}
