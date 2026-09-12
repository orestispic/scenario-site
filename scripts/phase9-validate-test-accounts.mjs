import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { accountDefinitions } from './phase9-provision-test-accounts.mjs';

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function validateAccount({
  definition,
  password,
  supabaseUrl,
  anonKey,
  apiUrl,
}) {
  const authHeaders = {
    Accept: 'application/json',
    apikey: anonKey,
    'Content-Type': 'application/json',
  };
  const login = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ email: definition.email, password }),
    },
  );
  if (!login.ok)
    throw new Error(
      `Supabase ${definition.role} login failed with HTTP ${login.status}.`,
    );
  const session = await login.json();
  if (
    typeof session.access_token !== 'string' ||
    typeof session.refresh_token !== 'string'
  )
    throw new Error(`Supabase ${definition.role} returned an invalid session.`);

  let profileError;
  try {
    const response = await fetch(`${apiUrl}/v1/me`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        Origin: 'http://127.0.0.1:1420',
      },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const code =
        typeof error.code === 'string' ? ` (${error.code})` : '';
      throw new Error(
        `Worker ${definition.role} profile check failed with HTTP ${response.status}${code}.`,
      );
    }
    const profile = await response.json();
    if (
      profile.account?.email?.toLowerCase() !== definition.email ||
      profile.role !== 'customer'
    )
      throw new Error(`Worker ${definition.role} profile does not match.`);
  } catch (error) {
    profileError = error;
  }
  const logout = await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  if (profileError) throw profileError;
  if (!logout.ok)
    throw new Error(
      `Supabase ${definition.role} logout failed with HTTP ${logout.status}.`,
    );
}

async function run() {
  const projectRef = argument('--project-ref');
  const apiUrl = argument('--api-url')?.replace(/\/$/, '');
  if (!projectRef || !apiUrl)
    throw new Error('--project-ref and --api-url are required.');
  const expectedSupabaseUrl = `https://${projectRef}.supabase.co`;
  const parsedApiUrl = new URL(apiUrl);
  if (
    parsedApiUrl.protocol !== 'https:' ||
    !parsedApiUrl.hostname.endsWith('.workers.dev') ||
    parsedApiUrl.pathname !== '/'
  )
    throw new Error('A root HTTPS workers.dev API URL is required.');

  const environment = parseEnvironmentFile(
    readFileSync(resolve('.env.phase9.local'), 'utf8'),
  );
  const credentials = parseEnvironmentFile(
    readFileSync(resolve('.env.phase9.accounts.local'), 'utf8'),
  );
  const supabaseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/, '');
  if (supabaseUrl !== expectedSupabaseUrl)
    throw new Error(
      `Refusing project mismatch; expected ${expectedSupabaseUrl}.`,
    );
  const anonKey = required(environment, 'SUPABASE_ANON_KEY');

  for (const definition of accountDefinitions(projectRef)) {
    const prefix = `PHASE9_${definition.role.toUpperCase()}`;
    if (required(credentials, `${prefix}_EMAIL`) !== definition.email)
      throw new Error(`${definition.role} credentials do not match.`);
    await validateAccount({
      definition,
      password: required(credentials, `${prefix}_PASSWORD`),
      supabaseUrl,
      anonKey,
      apiUrl,
    });
    console.log(`${definition.role}: login, profile and logout verified`);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Validation failed.');
  process.exitCode = 1;
});
