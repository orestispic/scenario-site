import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnvironmentFile } from './phase9-preflight.mjs';
import { accountDefinitions } from './phase9-provision-test-accounts.mjs';

const ORIGIN = 'http://127.0.0.1:1420';
const REQUIRED_WEBHOOKS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'invoice.paid',
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

function adminHeaders(secretKey) {
  const headers = {
    Accept: 'application/json',
    apikey: secretKey,
  };
  if (!secretKey.startsWith('sb_secret_'))
    headers.Authorization = `Bearer ${secretKey}`;
  return headers;
}

async function readRows(baseUrl, secretKey, table, parameters) {
  const response = await fetch(
    `${baseUrl}/rest/v1/${table}?${new URLSearchParams(parameters)}`,
    { headers: adminHeaders(secretKey) },
  );
  if (!response.ok)
    throw new Error(
      `Supabase ${table} validation failed (${response.status}).`,
    );
  return response.json();
}

async function waitForProjection(check) {
  let latestError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await check();
    } catch (error) {
      latestError = error;
      if (attempt < 9)
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, 2_000),
        );
    }
  }
  throw latestError;
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
  const secretKey =
    environment.SUPABASE_SECRET_KEY?.trim() ||
    required(environment, 'SUPABASE_SERVICE_ROLE_KEY');
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
    throw new Error(`Synthetic owner login failed (${login.status}).`);
  const session = await login.json();
  if (
    typeof session.access_token !== 'string' ||
    typeof session.user?.id !== 'string'
  )
    throw new Error('Synthetic owner session is invalid.');

  let failure;
  let result;
  try {
    result = await waitForProjection(async () => {
      const profiles = await readRows(supabaseUrl, secretKey, 'profiles', {
        auth_user_id: `eq.${session.user.id}`,
        select: 'id',
        limit: '1',
      });
      const profileId = profiles[0]?.id;
      if (typeof profileId !== 'string')
        throw new Error('Synthetic owner profile is missing.');
      const checkouts = await readRows(
        supabaseUrl,
        secretKey,
        'stripe_checkout_sessions',
        {
          profile_id: `eq.${profileId}`,
          select: 'id,status,price_id,completed_at,created_at',
          order: 'created_at.desc',
          limit: '1',
        },
      );
      const checkout = checkouts[0];
      if (checkout?.status !== 'completed' || !checkout.completed_at)
        throw new Error('Latest Stripe Checkout is not completed yet.');
      const prices = await readRows(supabaseUrl, secretKey, 'prices', {
        id: `eq.${checkout.price_id}`,
        select: 'offer_configuration_item_id',
        limit: '1',
      });
      const items = await readRows(
        supabaseUrl,
        secretKey,
        'offer_configuration_items',
        {
          id: `eq.${prices[0]?.offer_configuration_item_id}`,
          select: 'billing_period,offers!inner(offer_code)',
          limit: '1',
        },
      );
      if (
        items[0]?.billing_period !== 'month' ||
        items[0]?.offers?.offer_code !== 'studio'
      )
        throw new Error('Completed Checkout is not Studio monthly.');
      const subscriptions = await readRows(
        supabaseUrl,
        secretKey,
        'subscriptions',
        {
          user_id: `eq.${profileId}`,
          price_id: `eq.${checkout.price_id}`,
          select:
            'id,status,current_period_starts_at,current_period_ends_at,cancel_at_period_end',
          order: 'updated_at.desc',
          limit: '1',
        },
      );
      const subscription = subscriptions[0];
      if (
        subscription?.status !== 'active' ||
        !subscription.current_period_starts_at ||
        !subscription.current_period_ends_at
      )
        throw new Error('Studio monthly subscription is not active yet.');
      const invoices = await readRows(
        supabaseUrl,
        secretKey,
        'billing_invoices',
        {
          provider_created_at: `gte.${checkout.created_at}`,
          select: 'status,subscription_id,provider_created_at',
          order: 'provider_created_at.asc',
        },
      );
      if (
        !invoices.some(
          (invoice) =>
            invoice.status === 'paid' &&
            invoice.subscription_id === subscription.id,
        )
      )
        throw new Error(
          `Paid invoice is not linked to the subscription: ${JSON.stringify(
            invoices.map((invoice) => ({
              status: invoice.status,
              linked: invoice.subscription_id !== null,
            })),
          )}`,
        );
      const snapshots = await readRows(
        supabaseUrl,
        secretKey,
        'entitlement_snapshots',
        {
          user_id: `eq.${profileId}`,
          subscription_id: `eq.${subscription.id}`,
          source: 'eq.subscription',
          select: 'id,expires_at,payload,source_event_id',
          order: 'created_at.desc',
          limit: '1',
        },
      );
      const snapshot = snapshots[0];
      const entitlementCodes = new Set(
        Array.isArray(snapshot?.payload?.entitlements)
          ? snapshot.payload.entitlements.map((entry) => entry.code)
          : [],
      );
      if (
        !snapshot?.source_event_id ||
        Date.parse(snapshot?.expires_at ?? '') <= Date.now() ||
        !entitlementCodes.has('studio_collaboration') ||
        !entitlementCodes.has('cloud.sync')
      )
        throw new Error('Studio subscription entitlement snapshot is invalid.');
      const events = await readRows(
        supabaseUrl,
        secretKey,
        'stripe_webhook_events',
        {
          provider_created_at: `gte.${checkout.created_at}`,
          select: 'event_type,processing_status,processed_at',
          order: 'provider_created_at.asc',
        },
      );
      for (const eventType of REQUIRED_WEBHOOKS) {
        if (
          !events.some(
            (event) =>
              event.event_type === eventType &&
              event.processing_status === 'processed' &&
              event.processed_at,
          )
        )
          throw new Error(`Stripe webhook ${eventType} is not processed yet.`);
      }
      const billingResponse = await fetch(`${apiUrl}/v2/billing`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          Origin: ORIGIN,
        },
      });
      if (!billingResponse.ok)
        throw new Error(
          `Hosted billing state failed (${billingResponse.status}).`,
        );
      const billing = (await billingResponse.json()).billing;
      if (
        billing?.status !== 'active' ||
        billing.offerCode !== 'studio' ||
        billing.billingInterval !== 'month' ||
        billing.lastPaymentStatus !== 'paid' ||
        billing.source !== 'stripe' ||
        billing.testMode !== true
      )
        throw new Error(
          `Hosted API billing mismatch: ${JSON.stringify({
            status: billing?.status,
            offerCode: billing?.offerCode,
            billingInterval: billing?.billingInterval,
            lastPaymentStatus: billing?.lastPaymentStatus,
            source: billing?.source,
            testMode: billing?.testMode,
          })}`,
        );
      return {
        webhookCount: events.length,
        entitlementCount: entitlementCodes.size,
      };
    });
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
    throw new Error(`Synthetic owner logout failed (${logout.status}).`);
  console.log(
    `Stripe test Checkout verified (Studio monthly, ${result.webhookCount} processed events observed, ${result.entitlementCount} entitlements).`,
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Validation failed.');
  process.exitCode = 1;
});
