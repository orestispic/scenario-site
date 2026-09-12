import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { accountDefinitions } from './phase9-provision-test-accounts.mjs';

const ORIGIN = 'http://127.0.0.1:1420';
const OFFER_CODE = 'studio';
const BILLING_INTERVAL = 'month';

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function validateApiUrl(value) {
  const url = new URL(value.replace(/\/$/, ''));
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.workers.dev') ||
    url.pathname !== '/'
  )
    throw new Error('A root HTTPS workers.dev API URL is required.');
  return url.toString().replace(/\/$/, '');
}

export function validateCheckoutPayload(payload) {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    payload.testMode !== true ||
    typeof payload.checkoutUrl !== 'string' ||
    typeof payload.expiresAt !== 'string' ||
    typeof payload.request_id !== 'string'
  )
    throw new Error('Hosted Checkout response is invalid or not in test mode.');
  const checkoutUrl = new URL(payload.checkoutUrl);
  if (
    checkoutUrl.protocol !== 'https:' ||
    checkoutUrl.hostname !== 'checkout.stripe.com' ||
    !checkoutUrl.pathname.startsWith('/c/pay/')
  )
    throw new Error('Stripe returned an unexpected Checkout URL.');
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw new Error('Stripe Checkout session is already expired.');
  return checkoutUrl.toString();
}

export async function createTestCheckout({
  projectRef,
  apiUrl,
  fetcher = fetch,
}) {
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
  const login = await fetcher(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ email: owner.email, password }),
    },
  );
  if (!login.ok)
    throw new Error(`Synthetic owner login failed (${login.status}).`);
  const session = await login.json();
  if (typeof session.access_token !== 'string')
    throw new Error('Synthetic owner session is invalid.');

  let checkoutUrl;
  let failure;
  try {
    const billingResponse = await fetcher(`${apiUrl}/v2/billing`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        Origin: ORIGIN,
      },
    });
    if (!billingResponse.ok)
      throw new Error(
        `Hosted billing catalogue failed (${billingResponse.status}).`,
      );
    const billing = await billingResponse.json();
    const selections = Array.isArray(billing.offers)
      ? billing.offers.filter(
          (offer) =>
            offer.offerCode === OFFER_CODE &&
            offer.billingInterval === BILLING_INTERVAL &&
            offer.testMode === true,
        )
      : [];
    if (
      selections.length !== 1 ||
      typeof selections[0].selectionId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(selections[0].selectionId)
    )
      throw new Error('Exactly one Studio monthly test selection is required.');

    const checkoutResponse = await fetcher(`${apiUrl}/v2/checkout/sessions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        selectionId: selections[0].selectionId,
        successUrl: `${ORIGIN}/?checkout=success`,
        cancelUrl: `${ORIGIN}/?checkout=cancel`,
      }),
    });
    if (!checkoutResponse.ok)
      throw new Error(
        `Hosted Checkout creation failed (${checkoutResponse.status}).`,
      );
    checkoutUrl = validateCheckoutPayload(await checkoutResponse.json());
  } catch (error) {
    failure = error;
  }

  const logout = await fetcher(`${supabaseUrl}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  if (failure) throw failure;
  if (!logout.ok)
    throw new Error(`Synthetic owner logout failed (${logout.status}).`);
  return checkoutUrl;
}

async function run() {
  const projectRef = argument('--project-ref');
  const apiUrlArgument = argument('--api-url');
  if (!projectRef || !apiUrlArgument)
    throw new Error('--project-ref and --api-url are required.');
  const checkoutUrl = await createTestCheckout({
    projectRef,
    apiUrl: validateApiUrl(apiUrlArgument),
  });
  process.stdout.write(checkoutUrl);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  run().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Checkout creation failed.',
    );
    process.exitCode = 1;
  });
