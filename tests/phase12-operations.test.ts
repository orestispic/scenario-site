/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyBackup } from '../scripts/backup-integrity.mjs';
import { evaluateHealth, initialAlertState } from '../scripts/alert-policy.mjs';

test('offline backup verifies bytes and parent graph; never claims SQL restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'senario-backup-test-'));
  const bytes = Buffer.from('synthetic fixture only');
  const file = (name: string) => ({ file: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const version = { ...file('version.scenario'), scenarioId: 'synthetic-project', versionId: 'v1', parentVersionId: null as string | null };
  const manifest = { schemaVersion: 1, environment: 'staging', capturedAt: '2026-09-12T00:00:00Z', database: file('database.sql'), versions: [version] };
  try {
    await writeFile(join(dir, 'database.sql'), bytes); await writeFile(join(dir, 'version.scenario'), bytes);
    const save = () => writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    await save(); assert.deepEqual(await verifyBackup(dir), { event: 'backup.integrity', valid: true, files: 2, versions: 1, databaseRestoreVerified: false, offsiteRestoreVerified: false });
    version.parentVersionId = 'v1'; await save(); await assert.rejects(verifyBackup(dir), /Cyclic/);
    version.parentVersionId = 'missing'; await save(); await assert.rejects(verifyBackup(dir), /Missing/);
    version.parentVersionId = null; version.file = '../escape'; await save(); await assert.rejects(verifyBackup(dir), /Unsafe/);
    version.file = 'version.scenario'; await save(); await writeFile(join(dir, version.file), 'corrupt'); await assert.rejects(verifyBackup(dir), /mismatch/);
    await writeFile(join(dir, version.file), Buffer.alloc(bytes.length)); await assert.rejects(verifyBackup(dir), /checksum/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('incident policy opens once and recovers once, without sending notifications', () => {
  let state = initialAlertState(); const transitions = [];
  for (let i = 0; i < 5; i++) {
    const result = evaluateHealth(state, { at: i * 60_000, healthy: false, errorRate: 0, backlog: 0 });
    state = result.state; transitions.push(result.transition);
  }
  assert.deepEqual(transitions, ['none', 'none', 'opened', 'none', 'none']);
  const recovered = evaluateHealth(state, { at: 360_000, healthy: true, errorRate: 0, backlog: 0 });
  assert.equal(recovered.transition, 'recovered');
  assert.equal(evaluateHealth(recovered.state, { at: 420_000, healthy: true, errorRate: 0, backlog: 0 }).transition, 'none');
  const delayed = evaluateHealth(initialAlertState(), { at: 0, healthy: true, errorRate: 0, backlog: 101 });
  assert.equal(evaluateHealth(delayed.state, { at: 300_000, healthy: true, errorRate: 0, backlog: 101 }).transition, 'opened');
  assert.throws(() => evaluateHealth(delayed.state, { at: 0, healthy: true, errorRate: 0, backlog: 0 }));
});
