/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const migration = (
  await readFile(
    new URL(
      '../supabase/migrations/20260914000000_server_ai_quotas.sql',
      import.meta.url,
    ),
    'utf8',
  )
).toLowerCase();

it('conserve la migration de phase 4 byte-for-byte', async () => {
  const previous = await readFile(
    new URL(
      '../supabase/migrations/20260913000000_preproduction_hardening.sql',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(
    createHash('sha256').update(previous.replace(/\r\n/g, '\n')).digest('hex'),
    '755b4016f8d1307d8af7bc14890499384f5c26989a1dd8bea3cabcd53480c839',
  );
});

describe('migration phase 5', () => {
  it('réserve atomiquement et sépare les deux quotas serveur', () => {
    assert.match(migration, /pg_advisory_xact_lock/);
    assert.match(migration, /ai_short_action/);
    assert.match(migration, /ai_pdf_import/);
    assert.match(
      migration,
      /status in \('reserved', 'succeeded', 'uncertain'\)/,
    );
    assert.match(migration, /unique \(user_id, idempotency_key_hash\)/);
    assert.match(migration, /request_fingerprint <> p_request_fingerprint/);
  });

  it('lie l’usage au snapshot et rend son historique immuable', () => {
    assert.match(migration, /entitlement_snapshot_id uuid not null/);
    assert.match(migration, /ai_usage_events_immutable/);
    assert.match(migration, /reservation_id/);
    assert.doesNotMatch(
      migration,
      /(prompt_text|scenario_text|response_text|raw_prompt)/,
    );
  });

  it('réserve les RPC au service role et protège la nouvelle table par RLS', () => {
    assert.match(
      migration,
      /alter table public\.ai_quota_reservations enable row level security/,
    );
    assert.match(
      migration,
      /revoke all on public\.ai_quota_reservations from public, anon, authenticated/,
    );
    assert.match(
      migration,
      /grant execute on function public\.reserve_ai_quota[\s\S]*?to service_role/,
    );
    assert.doesNotMatch(
      migration,
      /grant (select|insert|update|delete|all) on public\.ai_quota_reservations to authenticated/,
    );
  });

  it('contrôle appareil, droits et version minimale dans la même RPC', () => {
    assert.match(migration, /status = 'active'/);
    assert.match(migration, /ai_entitlement_missing/);
    assert.match(migration, /client_update_required/);
    assert.match(migration, /semantic_version_at_least/);
  });
});
