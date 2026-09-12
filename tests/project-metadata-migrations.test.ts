/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
it('freezes the phase10 migration in addition to all earlier SHA-256 gates', async () => {
  const sql = await readFile(
    new URL(
      '../supabase/migrations/20260923000000_cloud_projects.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(
    createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
    '5d1efdb38169cf5e32aba83d628312c469039e870c83ea562c0549762ac4832a',
  );
});
it('new v10 metadata migration adds private atomic immutable history without altering legacy tables', async () => {
  const sql = await readFile(
    new URL(
      '../supabase/migrations/20260924000000_project_metadata.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const table of [
    'project_metadata_state',
    'project_metadata_operations',
    'project_metadata_snapshots',
  ])
    assert.match(
      sql,
      new RegExp('alter table public.' + table + ' enable row level security'),
    );
  assert.match(sql, /primary key\(actor_id,operation_id\)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /authorize_studio_operation/);
  assert.match(sql, /for update/);
  assert.match(sql, /project_metadata_operations_immutable/);
  assert.match(sql, /project_metadata_snapshots_immutable/);
  assert.doesNotMatch(
    sql,
    /disable row level security|grant[^;]+to authenticated|drop table/i,
  );
});
it('app and server v10 contracts are identical', async () => {
  const [a, b] = await Promise.all([
    readFile(
      new URL('../lib/commercial/contracts-v10.ts', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL(
        '../../scenario-app-commercial/src/commercial/contractsV10.ts',
        import.meta.url,
      ),
      'utf8',
    ),
  ]);
  assert.equal(a.replace(/\r\n/g, '\n'), b.replace(/\r\n/g, '\n'));
});
