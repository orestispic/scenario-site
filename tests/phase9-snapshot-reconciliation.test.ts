/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

test('phase 9 snapshot reconciliation is append-only and atomic', async () => {
  const sql = await readFile(
    new URL(
      '../supabase/migrations/20260919000000_studio_snapshot_reconciliation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(sql, /commit_studio_collaboration_snapshot_v2/);
  assert.match(sql, /authorize_studio_operation/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /scenario_parent_conflict/);
  assert.match(sql, /collaboration_ledger_incomplete/);
  assert.match(sql, /p_size_bytes not between 2 and 4194304/);
  assert.match(sql, /split_part\(p_storage_key,'\/',3\)<>v_scenario\.id::text/);
  assert.match(sql, /split_part\(p_storage_key,'\/',5\)<>p_snapshot_id::text/);
  assert.match(sql, /insert into public\.cloud_scenario_versions/);
  assert.match(sql, /insert into public\.studio_collaboration_snapshots/);
  assert.match(sql, /insert into public\.studio_collaboration_compactions/);
  assert.match(sql, /'revision'/);
  assert.match(sql, /revoke all on function/);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /localStorage|price_|sk_(?:test|live)_|whsec_/);
});
