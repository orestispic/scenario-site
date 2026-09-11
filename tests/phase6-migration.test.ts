/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const hashes: Record<string, string> = {
  '20260910000000_commercial_foundation.sql':
    'a38684bc511833af8fb1171bdaf1b2c9c0a8a2572a66528f6e0989bc75747c8d',
  '20260911000000_auth_rls.sql':
    '6a8584cce74ffa6d1d6bb422c6a49ff17e0271ab215b1a517fb3771304618448',
  '20260912000000_stripe_billing_activation.sql':
    '193ba98c9661b071c8457176cdb8c55dfc88e4dd0ed13237e0e16418ccc8cfa8',
  '20260913000000_preproduction_hardening.sql':
    '755b4016f8d1307d8af7bc14890499384f5c26989a1dd8bea3cabcd53480c839',
  '20260914000000_server_ai_quotas.sql':
    'bc0a1550f1c45410ea9baa36a42914e5917bddeb2154839c4b104549d33913e5',
};

it('fige SHA-256 de toutes les migrations antérieures à la phase 6', async () => {
  for (const [file, expected] of Object.entries(hashes)) {
    const source = await readFile(
      new URL(`../supabase/migrations/${file}`, import.meta.url),
      'utf8',
    );
    assert.equal(
      createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex'),
      expected,
      file,
    );
  }
});

describe('migration cloud v6', () => {
  it('est append-only, atomique, idempotente et conserve les versions immuables', async () => {
    const sql = (
      await readFile(
        new URL(
          '../supabase/migrations/20260915000000_cloud_sync_versions.sql',
          import.meta.url,
        ),
        'utf8',
      )
    ).toLowerCase();
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /unique \(user_id, idempotency_key_hash\)/);
    assert.match(sql, /scenario_parent_conflict/);
    assert.match(sql, /cloud_scenario_versions_immutable/);
    assert.match(
      sql,
      /origin in \('save', 'import', 'offline_replay', 'restore'\)/,
    );
    assert.match(sql, /entitlement_snapshot_id/);
    assert.match(sql, /request_id/);
    assert.doesNotMatch(sql, /drop table|truncate table/);
  });
  it('garde les écritures derrière les RPC service-role et les lectures RLS owner/membre actif', async () => {
    const sql = (
      await readFile(
        new URL(
          '../supabase/migrations/20260915000000_cloud_sync_versions.sql',
          import.meta.url,
        ),
        'utf8',
      )
    ).toLowerCase();
    assert.match(sql, /enable row level security/);
    assert.match(sql, /cloud_scenarios_select_member/);
    assert.match(sql, /status='active'|status = 'active'/);
    assert.match(
      sql,
      /grant execute on function public\.sync_cloud_scenario[\s\S]*to service_role/,
    );
    assert.doesNotMatch(sql, /grant (insert|update|delete).*to authenticated/);
    assert.match(sql, /cloud_device_inactive/);
    assert.match(sql, /cloud_entitlement_missing/);
    assert.match(sql, /client_update_required/);
  });
});
