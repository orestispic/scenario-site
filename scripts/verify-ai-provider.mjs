// Hosted provider smoke test using the synthetic Owner account.
// One tiny generation, or three with --all. Never logs credentials or model output.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { parseEnvironmentFile } from './phase9-preflight.mjs';

const PROJECT_REF = 'zblnsdyaoljnezxdidtx';
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const API_URL =
  'https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
const ORIGIN = 'http://127.0.0.1:1420';
const FINGERPRINT = `phase9-owner-${PROJECT_REF}-device`;

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

async function json(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      payload && typeof payload.code === 'string' ? ` (${payload.code})` : '';
    throw new Error(`Hosted AI request failed with HTTP ${response.status}${code}.`);
  }
  return payload;
}

async function main() {
  const environment = parseEnvironmentFile(
    readFileSync('.env.phase9.local', 'utf8'),
  );
  const credentials = parseEnvironmentFile(
    readFileSync('.env.phase9.accounts.local', 'utf8'),
  );
  assert.equal(
    required(environment, 'SUPABASE_URL').replace(/\/$/, ''),
    SUPABASE_URL,
  );

  const authHeaders = {
    Accept: 'application/json',
    apikey: required(environment, 'SUPABASE_ANON_KEY'),
    'Content-Type': 'application/json',
  };
  const login = await json(
    await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        email: required(credentials, 'PHASE9_OWNER_EMAIL'),
        password: required(credentials, 'PHASE9_OWNER_PASSWORD'),
      }),
    }),
  );
  assert.equal(typeof login.access_token, 'string');

  try {
    const catalogue = await json(
      await fetch(`${API_URL}/v1/config`, {
        headers: { Accept: 'application/json', Origin: ORIGIN },
      }),
    );
    const clientVersion = catalogue.compatibility?.[0]?.minimumSupportedVersion;
    assert.equal(typeof clientVersion, 'string');

    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${login.access_token}`,
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'Idempotency-Key': `ai-provider-smoke-${Date.now()}-${randomUUID()}`,
      'X-Scenario-Device-Fingerprint': FINGERPRINT,
      'X-Scenario-Platform': 'windows',
      'X-Scenario-Client-Version': clientVersion,
    };
    const before = await json(
      await fetch(`${API_URL}/v4/ai/usage`, {
        headers: {
          Accept: 'application/json',
          Authorization: headers.Authorization,
          Origin: ORIGIN,
        },
      }),
    );
    const generated = await json(
      await fetch(`${API_URL}/v4/ai/actions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          kind: 'rewrite',
          instruction: 'Corrige seulement la ponctuation.',
          text: 'Bonjour',
        }),
      }),
    );
    assert.equal(generated.status, 'succeeded');
    assert.equal(generated.replayed, false);
    assert.equal(generated.result?.kind, 'text');
    assert.ok(generated.result.text.trim());
    assert.ok(
      generated.budgets.daily.usedTokens > before.budgets.daily.usedTokens,
    );
    console.log(
      JSON.stringify({
        providerGeneration: 'ok',
        accounting: 'ok',
        chargedTokens:
          generated.budgets.daily.usedTokens - before.budgets.daily.usedTokens,
        dailyPercent: generated.budgets.daily.usedPercent,
        monthlyPercent: generated.budgets.monthly.usedPercent,
      }),
    );
    if (process.argv.includes('--all')) {
      // Retry the same admission: no generation and no second charge.
      const replay = await json(await fetch(`${API_URL}/v4/ai/actions`, {
        method: 'POST', headers,
        body: JSON.stringify({ kind: 'rewrite', instruction: 'Corrige seulement la ponctuation.', text: 'Bonjour' }),
      }));
      assert.equal(replay.replayed, true);
      assert.equal(replay.budgets.daily.usedTokens, generated.budgets.daily.usedTokens);
      console.log('PASS: replay does not charge again');
      for (const [name, path, body] of [
        ['translation', 'actions', { kind: 'translate', targetLanguage: 'English', segments: [{ index: 0, type: 'action', text: 'La porte se ferme.' }] }],
        ['pdf', 'pdf-imports', { extractedText: 'INT. SALON - JOUR\n\nUne porte se ferme.\n\nALICE\nBonjour.' }],
      ]) {
        const result = await json(await fetch(`${API_URL}/v4/ai/${path}`, {
          method: 'POST', headers: { ...headers, 'Idempotency-Key': `phase13-${name}-${randomUUID()}` }, body: JSON.stringify(body),
        }));
        assert.equal(result.status, 'succeeded', `${name} status`);
        if (name === 'translation') {
          assert.equal(result.result.kind, 'translations');
          assert.equal(result.result.translations.length, 1);
          assert.equal(result.result.translations[0].index, 0);
          assert.ok(result.result.translations[0].text.trim());
        } else {
          assert.equal(result.result.kind, 'scenario_json');
          const document = JSON.parse(result.result.scenarioJson);
          assert.equal(document.formatVersion, 1);
          assert.equal(document.content?.type, 'doc', 'PDF must be an editor document');
          assert.ok(Array.isArray(document.content.content) && document.content.content.length > 0, 'PDF must contain paragraphs');
          assert.ok(document.content.content.every(node => node.type === 'paragraph'), 'PDF paragraph structure');
        }
        console.log(`PASS: ${name}, server daily usage ${result.budgets.daily.usedPercent}%`);
      }
      const rejected = await fetch(`${API_URL}/v4/ai/actions`, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': `phase13-hostile-${randomUUID()}` },
        body: JSON.stringify({ kind: 'rewrite', instruction: 'Corrige', text: 'Bonjour', model: 'unauthorized-model', budget: 999999 }),
      });
      assert.equal(rejected.status, 400);
      const device = await fetch(`${API_URL}/v4/ai/actions`, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': `phase13-device-${randomUUID()}`, 'X-Scenario-Device-Fingerprint': `phase13-inactive-${randomUUID()}` },
        body: JSON.stringify({ kind: 'rewrite', instruction: 'Corrige', text: 'Bonjour' }),
      });
      assert.equal(device.status, 403);
      console.log('PASS: hosted model/budget override and inactive device refused');
    }
  } finally {
    const logout = await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        Authorization: `Bearer ${login.access_token}`,
      },
    });
    assert.ok(logout.ok);
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'Hosted AI provider verification failed.',
  );
  process.exitCode = 1;
});
