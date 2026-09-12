import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { accountDefinitions } from './phase9-provision-test-accounts.mjs';

const ORIGIN = 'http://127.0.0.1:1420';
const EXPECTED = new Map([
  ['author_ai:month', 880],
  ['author_ai:year', 8800],
  ['studio:month', 1500],
  ['studio:year', 15000],
]);

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function run() {
  const projectRef = argument('--project-ref');
  const apiUrl = argument('--api-url')?.replace(/\/$/, '');
  if (!projectRef || !apiUrl)
    throw new Error('--project-ref and --api-url are required.');
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
  if (new URL(supabaseUrl).hostname !== `${projectRef}.supabase.co`)
    throw new Error('Supabase project identity does not match --project-ref.');
  const anonKey = required(environment, 'SUPABASE_ANON_KEY');
  const owner = accountDefinitions(projectRef).find(
    (definition) => definition.role === 'owner',
  );
  if (!owner) throw new Error('Synthetic owner definition is unavailable.');
  const password = required(credentials, 'PHASE9_OWNER_PASSWORD');
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
      body: JSON.stringify({ email: owner.email, password }),
    },
  );
  if (!login.ok)
    throw new Error(
      `Synthetic Stripe validation login failed (${login.status}).`,
    );
  const session = await login.json();
  if (typeof session.access_token !== 'string')
    throw new Error('Synthetic Stripe validation session is invalid.');

  let failure;
  try {
    const response = await fetch(`${apiUrl}/v2/billing`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        Origin: ORIGIN,
      },
    });
    if (!response.ok)
      throw new Error(`Hosted billing catalogue failed (${response.status}).`);
    const payload = await response.json();
    if (
      !Array.isArray(payload.offers) ||
      payload.offers.length !== EXPECTED.size
    )
      throw new Error(
        'Hosted billing catalogue does not expose four selections.',
      );
    const found = new Map();
    for (const offer of payload.offers) {
      const key = `${offer.offerCode}:${offer.billingInterval}`;
      if (
        typeof offer.selectionId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(offer.selectionId) ||
        offer.currency !== 'EUR' ||
        offer.testMode !== true ||
        EXPECTED.get(key) !== offer.unitAmountMinor ||
        found.has(key)
      )
        throw new Error(`Hosted billing selection is invalid for ${key}.`);
      found.set(key, offer.selectionId);
    }
    if ([...EXPECTED.keys()].some((key) => !found.has(key)))
      throw new Error('Hosted billing catalogue is incomplete.');
    if (typeof payload.request_id !== 'string')
      throw new Error('Hosted billing response has no request_id.');
  } catch (error) {
    failure = error;
  }
  const logout = await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  if (failure) throw failure;
  if (!logout.ok)
    throw new Error(
      `Synthetic Stripe validation logout failed (${logout.status}).`,
    );
  console.log('Hosted Stripe test catalogue verified (4 server selections).');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Validation failed.');
  process.exitCode = 1;
});
