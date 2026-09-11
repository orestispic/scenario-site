/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const migration = (
  await readFile(
    new URL(
      '../supabase/migrations/20260912000000_stripe_billing_activation.sql',
      import.meta.url,
    ),
    'utf8',
  )
).toLowerCase();

describe('migration phase 3', () => {
  it('protège chaque nouvelle table par RLS et réserve les écritures au service role', () => {
    for (const table of [
      'stripe_customers',
      'stripe_checkout_sessions',
      'stripe_webhook_events',
      'billing_invoices',
      'activation_key_redemptions',
    ]) {
      assert.match(
        migration,
        new RegExp(`alter table public\\.${table} enable row level security`),
      );
    }
    assert.doesNotMatch(
      migration,
      /grant (insert|update|delete) on public\.(stripe_|billing_|activation_)/,
    );
    for (const routine of [
      'apply_verified_stripe_event',
      'redeem_activation_key',
      'revoke_activation_key',
    ]) {
      assert.match(
        migration,
        new RegExp(
          `grant execute on function public\\.${routine}[\\s\\S]*?to service_role`,
        ),
      );
    }
  });

  it('rend l’historique causal et les webhooks idempotents', () => {
    assert.match(migration, /provider_event_id text not null unique/);
    assert.match(migration, /on conflict \(provider_event_id\) do nothing/);
    assert.match(
      migration,
      /last_provider_event_created_at > p_event_created_at/,
    );
    assert.match(migration, /entitlement_snapshots_source_event_idx/);
    assert.match(migration, /reject_immutable_history_mutation/);
  });

  it('ne stocke jamais la clé brute et verrouille l’activation atomiquement', () => {
    assert.match(migration, /where key_hash = p_key_hash for update/);
    assert.match(migration, /activation_count >= v_key\.maximum_activations/);
    assert.match(migration, /public\.activate_device/);
    assert.doesNotMatch(
      migration,
      /(plaintext_key|raw_key|key_plain|activation_key_value)/,
    );
  });
});
