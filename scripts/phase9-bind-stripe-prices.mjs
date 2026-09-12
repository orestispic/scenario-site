import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvironmentFile } from './phase9-preflight.mjs';

const ITEMS = [
  {
    argument: '--author-month',
    itemId: '91000000-0000-4000-8000-000000000202',
    offerCode: 'author_ai',
    period: 'month',
    amount: 880,
  },
  {
    argument: '--author-year',
    itemId: '91000000-0000-4000-8000-000000000203',
    offerCode: 'author_ai',
    period: 'year',
    amount: 8800,
  },
  {
    argument: '--studio-month',
    itemId: '91000000-0000-4000-8000-000000000204',
    offerCode: 'studio',
    period: 'month',
    amount: 1500,
  },
  {
    argument: '--studio-year',
    itemId: '91000000-0000-4000-8000-000000000205',
    offerCode: 'studio',
    period: 'year',
    amount: 15000,
  },
];

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function deterministicUuid(label) {
  const bytes = createHash('sha256').update(label).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateStripePriceIds(values) {
  const ids = ITEMS.map(({ argument: name }) => values[name]);
  if (ids.some((value) => !/^price_[A-Za-z0-9]+$/.test(value ?? '')))
    throw new Error('Every Stripe test Price id must start with price_.');
  if (new Set(ids).size !== ids.length)
    throw new Error('Stripe test Price ids must be distinct.');
  return ids;
}

function adminHeaders(secretKey, extra = {}) {
  const headers = {
    Accept: 'application/json',
    apikey: secretKey,
    'Content-Type': 'application/json',
    ...extra,
  };
  if (!secretKey.startsWith('sb_secret_'))
    headers.Authorization = `Bearer ${secretKey}`;
  return headers;
}

async function adminRequest(baseUrl, secretKey, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: adminHeaders(secretKey, init.headers),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `Supabase Stripe binding failed with HTTP ${response.status}.`,
    );
  return text ? JSON.parse(text) : null;
}

function restPath(table, parameters) {
  return `/rest/v1/${table}?${new URLSearchParams(parameters)}`;
}

export async function bindStripePrices({
  projectRef,
  values,
  environmentPath = '.env.phase9.local',
}) {
  const environment = parseEnvironmentFile(
    readFileSync(resolve(environmentPath), 'utf8'),
  );
  const supabaseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/, '');
  const secretKey =
    environment.SUPABASE_SECRET_KEY?.trim() ||
    required(environment, 'SUPABASE_SERVICE_ROLE_KEY');
  if (new URL(supabaseUrl).hostname !== `${projectRef}.supabase.co`)
    throw new Error('Supabase project identity does not match --project-ref.');
  const priceIds = validateStripePriceIds(values);
  const itemIds = ITEMS.map(({ itemId }) => itemId);
  const items = await adminRequest(
    supabaseUrl,
    secretKey,
    restPath('offer_configuration_items', {
      id: `in.(${itemIds.join(',')})`,
      select:
        'id,billing_period,currency,price_minor,is_visible,offers!inner(offer_code)',
    }),
  );
  for (const expected of ITEMS) {
    const item = items.find((candidate) => candidate.id === expected.itemId);
    if (
      !item ||
      item.offers?.offer_code !== expected.offerCode ||
      item.billing_period !== expected.period ||
      item.currency !== 'EUR' ||
      item.price_minor !== expected.amount ||
      item.is_visible !== true
    )
      throw new Error(`Server catalogue mismatch for ${expected.offerCode}.`);
  }
  const existing = await adminRequest(
    supabaseUrl,
    secretKey,
    restPath('prices', {
      offer_configuration_item_id: `in.(${itemIds.join(',')})`,
      provider: 'eq.stripe',
      select: 'id,offer_configuration_item_id,provider_price_id,active_until',
    }),
  );
  const created = [];
  const replayed = [];
  for (const [index, expected] of ITEMS.entries()) {
    const matches = existing.filter(
      (candidate) =>
        candidate.offer_configuration_item_id === expected.itemId &&
        candidate.active_until === null,
    );
    if (
      matches.length > 1 ||
      matches[0]?.provider_price_id !== priceIds[index]
    ) {
      if (matches.length > 0)
        throw new Error(
          `Existing Stripe binding conflicts for ${expected.offerCode}.`,
        );
      const reused = existing.find(
        (candidate) => candidate.provider_price_id === priceIds[index],
      );
      if (reused)
        throw new Error(
          'A Stripe Price id is already bound to another selection.',
        );
      await adminRequest(supabaseUrl, secretKey, '/rest/v1/prices', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          id: deterministicUuid(
            `${projectRef}:phase9:stripe:${expected.offerCode}:${expected.period}`,
          ),
          offer_configuration_item_id: expected.itemId,
          provider: 'stripe',
          provider_price_id: priceIds[index],
        }),
      });
      created.push(`${expected.offerCode}:${expected.period}`);
    } else replayed.push(`${expected.offerCode}:${expected.period}`);
  }
  const verified = await adminRequest(
    supabaseUrl,
    secretKey,
    restPath('prices', {
      provider_price_id: `in.(${priceIds.join(',')})`,
      active_until: 'is.null',
      select: 'id,offer_configuration_item_id,provider_price_id',
    }),
  );
  if (verified.length !== ITEMS.length)
    throw new Error('Stripe Price bindings are incomplete after provisioning.');
  return { created, replayed, count: verified.length };
}

async function run() {
  const projectRef = argument('--project-ref');
  if (!projectRef) throw new Error('--project-ref is required.');
  const values = Object.fromEntries(
    ITEMS.map(({ argument: name }) => [name, argument(name)]),
  );
  const result = await bindStripePrices({ projectRef, values });
  console.log(
    `Stripe test bindings verified (${result.count}; ${result.created.length} created, ${result.replayed.length} replayed).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  run().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Stripe binding failed.',
    );
    process.exitCode = 1;
  });
