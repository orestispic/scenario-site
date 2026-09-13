// Read-only hosted smoke check, apart from a synthetic account's temporary login/logout.
// Never invokes a generation or logs email/password/token/provider errors.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseEnvironmentFile } from './phase9-preflight.mjs';

async function main() {
  const env = parseEnvironmentFile(readFileSync('.env.phase9.local', 'utf8'));
  const credentials = parseEnvironmentFile(readFileSync('.env.phase9.accounts.local', 'utf8'));
  const root = 'https://zblnsdyaoljnezxdidtx.supabase.co';
  const api = 'https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
  assert.equal(env.SUPABASE_URL.replace(/\/$/, ''), root);
  assert.equal(credentials.PHASE9_OWNER_EMAIL, 'phase9-owner-zblnsdyaoljnezxdidtx@example.com');
  const authHeaders = { apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  const unauthenticated = await fetch(`${api}/v4/ai/usage`);
  assert.equal(unauthenticated.status, 401);
  const login = await fetch(`${root}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ email: credentials.PHASE9_OWNER_EMAIL, password: credentials.PHASE9_OWNER_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  try {
    const response = await fetch(`${api}/v4/ai/usage`, {
      headers: { Authorization: `Bearer ${session.access_token}`, Origin: 'http://127.0.0.1:1420' },
    });
    assert.equal(response.status, 200);
    const { budgets } = await response.json();
    assert.ok(budgets.daily.limitTokens > 0);
    assert.equal(typeof budgets.daily.usedPercent, 'number');
    assert.equal(typeof budgets.monthly.usedPercent, 'number');
    const forbidden = await fetch(`${root}/rest/v1/rpc/ai_token_command`, {
      method: 'POST', headers: { ...authHeaders, Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ p_profile_id: session.user.id, p_action: 'usage' }),
    });
    assert.ok([401,403,404].includes(forbidden.status));
    console.log(JSON.stringify({ authenticatedUsage: 'ok', anonymousDenied: true, directRpcDenied: true,
      dailyTokens: budgets.daily.limitTokens, monthlyTokens: budgets.monthly.limitTokens,
      dailyPercent: budgets.daily.usedPercent, monthlyPercent: budgets.monthly.usedPercent, generationCalled: false }));
  } finally {
    const logout = await fetch(`${root}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: { ...authHeaders, Authorization: `Bearer ${session.access_token}` },
    });
    assert.ok(logout.ok);
  }
}
main().catch(() => { console.error('AI token hosted verification failed. No secret or user content logged.'); process.exitCode = 1; });
