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
};

it('fige SHA-256 de toutes les migrations des phases 0 à 6', async () => {
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

describe('migration Studio v7', () => {
  it('est append-only, RLS, idempotente et conserve journaux/tokens immuables', async () => {
    const sql = (
      await readFile(
        new URL(
          '../supabase/migrations/20260916000000_studio_collaboration.sql',
          import.meta.url,
        ),
        'utf8',
      )
    ).toLowerCase();
    for (const table of [
      'studios',
      'studio_memberships',
      'studio_membership_revisions',
      'studio_invitations',
      'studio_events',
      'studio_idempotency_keys',
    ])
      assert.match(
        sql,
        new RegExp(`alter table public\\.${table} enable row level security`),
      );
    assert.match(sql, /token_hash text not null unique/);
    assert.match(sql, /recipient_email_hash/);
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.match(sql, /for update/);
    assert.match(sql, /last_owner_required/);
    assert.match(sql, /self_role_change_forbidden/);
    assert.match(sql, /studio_events_immutable/);
    assert.match(sql, /studio_membership_revisions_immutable/);
    assert.match(sql, /studio_events_audit/);
    assert.match(sql, /insert into public\.audit_log/);
    assert.match(
      sql,
      /grant execute on function public\.accept_studio_invitation[\s\S]*to service_role/,
    );
    assert.doesNotMatch(
      sql,
      /grant (insert|update|delete)[\s\S]*to authenticated/,
    );
    assert.doesNotMatch(sql, /drop table|truncate table/);
  });
  it('réévalue droits, appareil, version, membership actif et scénario non supprimé', async () => {
    const sql = (
      await readFile(
        new URL(
          '../supabase/migrations/20260916000000_studio_collaboration.sql',
          import.meta.url,
        ),
        'utf8',
      )
    ).toLowerCase();
    assert.match(sql, /authorize_cloud_operation/);
    assert.match(sql, /studio_collaboration/);
    assert.match(sql, /m\.status='active'/);
    assert.match(sql, /deleted_at is null/);
    assert.match(sql, /invitation_expired/);
    assert.match(sql, /invitation_not_pending/);
  });
});
