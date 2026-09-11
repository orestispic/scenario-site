/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inspectPhase9Server,
  parseEnvironmentFile,
} from '../scripts/phase9-preflight.mjs';

const validEnvironment = {
  SCENARIO_ENVIRONMENT: 'staging',
  API_ALLOWED_ORIGINS:
    'https://app-staging.scenario.test,tauri://localhost,http://tauri.localhost',
  SUPABASE_URL: 'https://scenario-staging.supabase.co',
  SUPABASE_ANON_KEY: 'anon_test_value',
  SUPABASE_SECRET_KEY: 'sb_secret_synthetic_unit_test',
  STRIPE_SECRET_KEY: 'sk_test_synthetic_unit_test',
  STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_unit_test',
  DEVICE_FINGERPRINT_PEPPER: 'a'.repeat(32),
  RATE_LIMIT_KEY_PEPPER: 'b'.repeat(32),
  ACTIVATION_KEY_PEPPER: 'c'.repeat(32),
  AI_IDEMPOTENCY_PEPPER: 'd'.repeat(32),
  CLOUD_IDEMPOTENCY_PEPPER: 'e'.repeat(32),
  STUDIO_INVITATION_PEPPER: 'f'.repeat(32),
  STUDIO_TICKET_PEPPER: 'g'.repeat(32),
  OFFLINE_GRANT_KEY_ID: 'staging-test-key',
  OFFLINE_GRANT_PRIVATE_JWK: JSON.stringify({
    kty: 'EC',
    crv: 'P-256',
    x: 'synthetic-x',
    y: 'synthetic-y',
    d: 'synthetic-private',
  }),
  OFFLINE_GRANT_PUBLIC_JWK: JSON.stringify({
    kty: 'EC',
    crv: 'P-256',
    x: 'synthetic-x',
    y: 'synthetic-y',
  }),
  OPENAI_API_KEY: 'synthetic-test-api-key',
  OPENAI_SHORT_ACTION_MODEL: 'synthetic-model',
  OPENAI_PDF_IMPORT_MODEL: 'synthetic-model',
};
const safeConfig = `
workers_dev = false
preview_urls = false
[[durable_objects.bindings]]
name = "STUDIO_REALTIME_CHANNEL"
class_name = "StudioRealtimeChannel"
`;

describe('préflight phase 9', () => {
  it('parse un fichier local sans interpréter ses valeurs', () => {
    assert.deepEqual(
      parseEnvironmentFile('A="un deux"\n# secret\nB=trois=quatre\n'),
      { A: 'un deux', B: 'trois=quatre' },
    );
  });

  it('accepte uniquement une configuration test complète et isolée', () => {
    const report = inspectPhase9Server(validEnvironment, safeConfig);
    assert.equal(report.ready, true);
    assert.ok(report.checks.every((check) => check.ready));
  });

  it('accepte encore la clé service_role historique pendant la transition', () => {
    const { SUPABASE_SECRET_KEY: _, ...legacyEnvironment } = validEnvironment;
    const report = inspectPhase9Server(
      {
        ...legacyEnvironment,
        SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-unit-test',
      },
      safeConfig,
    );
    assert.equal(report.ready, true);
  });

  it('refuse clés live, placeholders, secrets réutilisés et canal absent', () => {
    const report = inspectPhase9Server(
      {
        ...validEnvironment,
        SUPABASE_URL: 'https://project-ref.supabase.co',
        API_ALLOWED_ORIGINS: 'https://preproduction.example.invalid',
        STRIPE_SECRET_KEY: 'sk_live_forbidden',
        STUDIO_TICKET_PEPPER: validEnvironment.STUDIO_INVITATION_PEPPER,
      },
      'workers_dev = true\npreview_urls = true',
    );
    assert.equal(report.ready, false);
    const failures = report.checks
      .filter((check) => !check.ready)
      .map((check) => check.name);
    assert.ok(failures.includes('projet Supabase test'));
    assert.ok(failures.includes('origines de préproduction'));
    assert.ok(failures.includes('Stripe test uniquement'));
    assert.ok(failures.includes('secrets techniques séparés'));
    assert.ok(failures.includes('canal Studio Cloudflare'));
    assert.ok(failures.includes('configuration Cloudflare privée'));
  });
});
