import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseEnvironmentFile } from './phase9-preflight.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function validateAdminGrantInput({ email, offer, reason, expiresAt }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? '') || String(email).length > 254)
    throw new Error('Adresse e-mail invalide.');
  if (!['author_ai', 'studio'].includes(offer)) throw new Error('Offre administrative invalide.');
  if (!reason || reason.trim().length < 5 || reason.length > 500) throw new Error('Motif invalide.');
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()))
    throw new Error('Expiration invalide.');
  return { email: email.toLowerCase(), offer, reason: reason.trim(), expiresAt: expiresAt ?? null };
}

async function main() {
  const input = validateAdminGrantInput({
    email: option('--email'), offer: option('--offer'), reason: option('--reason'), expiresAt: option('--expires-at'),
  });
  if (!process.argv.includes('--apply')) {
    console.log(`Attribution validée : ${input.offer} pour ${input.email} (aucune modification serveur).`);
    return;
  }
  const envFile = option('--env-file');
  const env = { ...(envFile ? parseEnvironmentFile(readFileSync(resolve(envFile), 'utf8')) : {}), ...process.env };
  const url = new URL(env.SUPABASE_URL ?? '');
  const projectRef = option('--project-ref');
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? '') || url.origin !== `https://${projectRef}.supabase.co`)
    throw new Error('Projet Supabase explicite et concordant requis.');
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Identifiant serveur Supabase requis.');
  const headers = {
    apikey: key,
    ...(!key.startsWith('sb_secret_') ? { Authorization: `Bearer ${key}` } : {}),
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${url.origin}/rest/v1/rpc/grant_admin_offer`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers,
    body: JSON.stringify({
      p_profile_email: input.email,
      p_offer_code: input.offer,
      p_expires_at: input.expiresAt,
      p_reason: input.reason,
    }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const code = typeof failure?.code === 'string' ? failure.code.slice(0, 32) : 'unknown';
    const message = typeof failure?.message === 'string' ? failure.message.slice(0, 160) : 'erreur serveur';
    throw new Error(`Attribution refusée (HTTP ${response.status}, ${code}) : ${message}`);
  }
  const result = await response.json();
  if (result?.offerCode !== input.offer || typeof result?.snapshotId !== 'string')
    throw new Error('Réponse d’attribution invalide.');
  const profileResponse = await fetch(`${url.origin}/rest/v1/profiles?email=eq.${encodeURIComponent(input.email)}&select=id&limit=1`, {
    redirect: 'error', signal: AbortSignal.timeout(15_000), headers,
  });
  if (!profileResponse.ok) throw new Error('Profil attribué invérifiable.');
  const profileRows = await profileResponse.json();
  const profileId = profileRows?.[0]?.id;
  if (typeof profileId !== 'string') throw new Error('Profil attribué introuvable après écriture.');
  const [billingResponse, quotaOfferResponse] = await Promise.all([
    fetch(`${url.origin}/rest/v1/rpc/get_billing_state`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers,
      body: JSON.stringify({ p_profile_id: profileId }),
    }),
    fetch(`${url.origin}/rest/v1/rpc/ai_token_offer`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers,
      body: JSON.stringify({ p_profile_id: profileId }),
    }),
  ]);
  const billing = billingResponse.ok ? await billingResponse.json() : null;
  const quotaOfferCode = quotaOfferResponse.ok ? await quotaOfferResponse.json() : null;
  if (billing?.offerCode !== input.offer || billing?.status !== 'active' || billing?.source !== 'admin_grant' || quotaOfferCode !== input.offer)
    throw new Error('Attribution écrite mais vérification des droits incomplète.');
  console.log(`Offre ${input.offer} attribuée à ${input.email}${result.replayed ? ' (déjà active)' : ''}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Attribution impossible.');
    console.error('Aucun secret n’a été affiché.');
    process.exitCode = 1;
  });
}
