/** Project front matter / annotations. Independent of v8 text operations. */
export const METADATA_CONTRACT = '2026-09-v10' as const;
export const COVER_FIELDS = [
  'projectName',
  'screenwriter',
  'director',
  'production',
  'duration',
  'version',
  'date',
  'rights',
  'contactName',
  'contactEmail',
  'contactPhone',
  'contactWebsite',
] as const;
export interface ProjectComment {
  id: string;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt: string | null;
  anchor: {
    sceneId: string;
    blockId: string;
    startOffset: number;
    endOffset: number;
    originalText: string;
    lost: boolean;
  };
  messages: {
    id: string;
    text: string;
    createdAt: string;
    editedAt: string | null;
  }[];
}
export interface ProjectMetadata {
  title: string;
  coverPage: Record<(typeof COVER_FIELDS)[number], string>;
  coverPageHidden: boolean;
  comments: ProjectComment[];
}
export interface MetadataRegister {
  revision: number;
  value: string | boolean | ProjectComment | null;
}
export interface MetadataState {
  scenarioId: string;
  baseVersionId: string;
  revision: number;
  registers: Record<string, MetadataRegister>;
}
export interface MetadataChange {
  key: string;
  expectedRevision: number;
  value: MetadataRegister['value'];
}
export interface MetadataWrite {
  operationId: string;
  changes: MetadataChange[];
}
export interface MetadataResponse {
  contractVersion: typeof METADATA_CONTRACT;
  state: MetadataState;
  status: 'current' | 'applied' | 'conflict';
  conflictKeys: string[];
  replayed: boolean;
  request_id: string;
}
const id = /^[a-zA-Z0-9_-]{1,128}$/;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (): never => {
  throw new Error('project_metadata_invalid');
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !(k in value))
  )
    fail();
}
function text(value: unknown, max: number) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.includes('\u0000')
  )
    fail();
}
function timestamp(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  )
    fail();
}
export function validateMetadataValue(key: string, value: unknown): void {
  if (key === 'title') {
    text(value, 200);
    if (!(value as string).trim()) fail();
    return;
  }
  if (key === 'cover.hidden') {
    if (typeof value !== 'boolean') fail();
    return;
  }
  if (COVER_FIELDS.some((f) => key === `cover.${f}`)) {
    text(value, 4096);
    return;
  }
  if (!key.startsWith('comment:') || !id.test(key.slice(8))) fail();
  if (value === null) return; // Durable tombstone, never resurrected by a stale write.
  const c = record(value);
  exact(c, ['id', 'status', 'createdAt', 'resolvedAt', 'anchor', 'messages']);
  if (c.id !== key.slice(8) || !['open', 'resolved'].includes(String(c.status)))
    fail();
  timestamp(c.createdAt);
  if (c.resolvedAt !== null) timestamp(c.resolvedAt);
  const a = record(c.anchor);
  exact(a, [
    'sceneId',
    'blockId',
    'startOffset',
    'endOffset',
    'originalText',
    'lost',
  ]);
  if (
    typeof a.sceneId !== 'string' ||
    typeof a.blockId !== 'string' ||
    !id.test(a.sceneId) ||
    !id.test(a.blockId) ||
    typeof a.lost !== 'boolean'
  )
    fail();
  if (
    !Number.isSafeInteger(a.startOffset) ||
    !Number.isSafeInteger(a.endOffset) ||
    Number(a.startOffset) < 0 ||
    Number(a.endOffset) < Number(a.startOffset) ||
    (!a.lost && a.endOffset === a.startOffset) ||
    Number(a.endOffset) > 4_194_304
  )
    fail();
  text(a.originalText, 16384);
  if (
    !Array.isArray(c.messages) ||
    !c.messages.length ||
    c.messages.length > 100
  )
    fail();
  const ids = new Set<string>();
  for (const m of c.messages as unknown[]) {
    const msg = record(m);
    exact(msg, ['id', 'text', 'createdAt', 'editedAt']);
    if (typeof msg.id !== 'string' || !id.test(msg.id) || ids.has(msg.id))
      fail();
    ids.add(String(msg.id));
    text(msg.text, 16384);
    timestamp(msg.createdAt);
    if (msg.editedAt !== null) timestamp(msg.editedAt);
  }
  if (new TextEncoder().encode(JSON.stringify(c)).length > 65536) fail();
}
export function validateMetadataWrite(value: unknown): MetadataWrite {
  const body = record(value);
  exact(body, ['operationId', 'changes']);
  if (
    !uuid.test(String(body.operationId)) ||
    !Array.isArray(body.changes) ||
    !body.changes.length ||
    body.changes.length > 32
  )
    fail();
  const keys = new Set<string>();
  for (const change of body.changes as unknown[]) {
    const c = record(change);
    exact(c, ['key', 'expectedRevision', 'value']);
    if (
      typeof c.key !== 'string' ||
      keys.has(c.key) ||
      !Number.isSafeInteger(c.expectedRevision) ||
      Number(c.expectedRevision) < 0
    )
      fail();
    keys.add(c.key as string);
    validateMetadataValue(c.key as string, c.value);
  }
  if (new TextEncoder().encode(JSON.stringify(body)).length > 131072) fail();
  return body as unknown as MetadataWrite;
}
export function metadataRegisters(
  metadata: ProjectMetadata,
): Record<string, MetadataRegister['value']> {
  return Object.fromEntries([
    ['title', metadata.title],
    ['cover.hidden', metadata.coverPageHidden],
    ...COVER_FIELDS.map((f) => [`cover.${f}`, metadata.coverPage[f]]),
    ...metadata.comments.map((c) => [`comment:${c.id}`, c]),
  ]);
}
export function metadataFromRegisters(
  registers: MetadataState['registers'],
): ProjectMetadata {
  const title = registers.title?.value;
  return {
    title: typeof title === 'string' ? title : 'Sans titre',
    coverPageHidden: registers['cover.hidden']?.value === true,
    coverPage: Object.fromEntries(
      COVER_FIELDS.map((f) => {
        const value = registers[`cover.${f}`]?.value;
        return [f, typeof value === 'string' ? value : ''];
      }),
    ) as ProjectMetadata['coverPage'],
    comments: Object.entries(registers)
      .filter(([k, v]) => k.startsWith('comment:') && v.value !== null)
      .map(([, v]) => structuredClone(v.value) as ProjectComment)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
  };
}
export function seedMetadata(file: unknown): Record<string, MetadataRegister> {
  const f = record(file),
    cover = (f.coverPage ?? {}) as Record<string, unknown>;
  if (f.formatVersion !== 1) fail();
  const values: Record<string, unknown> = {
    title:
      typeof f.title === 'string' && f.title.trim() ? f.title : 'Sans titre',
    'cover.hidden': f.coverPageHidden === true,
  };
  for (const field of COVER_FIELDS)
    values[`cover.${field}`] = cover[field] ?? '';
  if (f.comments !== undefined && !Array.isArray(f.comments)) fail();
  for (const c of (f.comments ?? []) as ProjectComment[]) {
    if (!c || values[`comment:${c.id}`]) fail();
    values[`comment:${c.id}`] = c;
  }
  const result = Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      validateMetadataValue(key, value);
      return [key, { revision: 0, value: value as MetadataRegister['value'] }];
    }),
  );
  validateRegisters(result);
  return result;
}
export function validateRegisters(
  value: unknown,
): asserts value is MetadataState['registers'] {
  const registers = record(value);
  if (
    Object.keys(registers).length > 512 ||
    new TextEncoder().encode(JSON.stringify(registers)).length > 524288
  )
    fail();
  for (const key of [
    'title',
    'cover.hidden',
    ...COVER_FIELDS.map((f) => `cover.${f}`),
  ])
    if (!(key in registers)) fail();
  for (const [key, value] of Object.entries(registers)) {
    const r = record(value);
    exact(r, ['revision', 'value']);
    if (!Number.isSafeInteger(r.revision) || Number(r.revision) < 0) fail();
    validateMetadataValue(key, r.value);
  }
}
export function parseMetadataResponse(value: unknown): MetadataResponse {
  const body = record(value),
    state = record(body.state);
  if (
    body.contractVersion !== METADATA_CONTRACT ||
    !['current', 'applied', 'conflict'].includes(String(body.status)) ||
    typeof body.replayed !== 'boolean' ||
    typeof body.request_id !== 'string' ||
    !Array.isArray(body.conflictKeys) ||
    body.conflictKeys.some((k) => typeof k !== 'string' || k.length > 140)
  )
    fail();
  if (
    !uuid.test(String(state.scenarioId)) ||
    !uuid.test(String(state.baseVersionId)) ||
    !Number.isSafeInteger(state.revision) ||
    Number(state.revision) < 0
  )
    fail();
  validateRegisters(state.registers);
  if (
    Object.values(state.registers).some(
      (r) => r.revision > Number(state.revision),
    )
  )
    fail();
  return body as unknown as MetadataResponse;
}
