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
  '20260915000000_cloud_sync_versions.sql':
    '9993d22286cddc5bd5a50379a3277201b265eaf7ace1084d6f3c79acfcf6f7b9',
  '20260916000000_studio_collaboration.sql':
    '1daa29fbedc97f69cb7e240332b4b39dbe89186f49e2f7fdc587bcb51be03e82',
};

it('fige SHA-256 de toutes les migrations des phases 0 à 7', async () => {
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

describe('migration collaborative v8', () => {
  it('reste append-only, RLS, bornée et atomique', async () => {
    const sql = (
      await readFile(
        new URL(
          '../supabase/migrations/20260917000000_studio_realtime_collaboration.sql',
          import.meta.url,
        ),
        'utf8',
      )
    ).toLowerCase();
    for (const table of [
      'studio_collaboration_operations',
      'studio_collaboration_conflicts',
      'studio_collaboration_conflict_resolutions',
      'studio_collaboration_snapshots',
      'studio_collaboration_acknowledgements',
      'studio_collaboration_tickets',
      'studio_collaboration_compactions',
    ])
      assert.match(
        sql,
        new RegExp(`alter table public\\.${table} enable row level security`),
      );
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /operation_id uuid primary key/);
    assert.match(sql, /unique\(studio_id, actor_profile_id, client_sequence\)/);
    assert.match(sql, /ticket_hash text primary key/);
    assert.match(sql, /maximum_uses=1/);
    assert.match(sql, /authorize_studio_operation/);
    assert.match(sql, /studio_collaboration_operations_immutable/);
    assert.match(sql, /studio_collaboration_snapshots_immutable/);
    assert.match(sql, /studio_collaboration_compactions_immutable/);
    assert.match(
      sql,
      /grant execute on function public\.append_studio_collaboration_operation[\s\S]*to service_role/,
    );
    assert.doesNotMatch(
      sql,
      /grant (insert|update|delete)[\s\S]*to authenticated/,
    );
    assert.doesNotMatch(sql, /drop table|truncate table/);
  });
  it('ne persiste pas la présence et garde les conflits/récupérations explicites', async () => {
    const sql = (
      await readFile(
        new URL(
          '../supabase/migrations/20260917000000_studio_realtime_collaboration.sql',
          import.meta.url,
        ),
        'utf8',
      )
    ).toLowerCase();
    assert.doesNotMatch(sql, /create table public\.studio_presence/);
    assert.match(sql, /concurrent_same_block/);
    assert.match(sql, /stale_tombstone/);
    assert.match(sql, /parent_version_id uuid not null/);
    assert.match(sql, /parent_snapshot_id uuid/);
  });
});
