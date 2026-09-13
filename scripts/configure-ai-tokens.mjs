import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseEnvironmentFile } from './phase9-preflight.mjs';

export function compileAiPolicy(input) {
  const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  if (typeof input.enabled !== 'boolean' || !Number.isFinite(input.eurPerUsdCeiling) || input.eurPerUsdCeiling < 0.1 || input.eurPerUsdCeiling > 10)
    throw new Error('Invalid enabled / eurPerUsdCeiling');
  const models = Object.fromEntries(['short_action', 'pdf_import'].map(operation => {
    const model = input.models?.[operation];
    if (!model || !/^[a-zA-Z0-9._-]{1,100}$/.test(model.model)
      || !integer(model.maxInputTokens, 200000) || model.maxInputTokens < 1
      || !integer(model.maxOutputTokens, 64000) || model.maxOutputTokens < 16
      || ![undefined, 'minimal', 'low', 'medium', 'high'].includes(model.reasoningEffort)) throw new Error(`Invalid model: ${operation}`);
    const rates = [model.inputUsdPerMillion, model.outputUsdPerMillion];
    if (rates.some(rate => !Number.isFinite(rate) || rate <= 0 || rate > 1000)) throw new Error(`Invalid rates: ${operation}`);
    return [operation, {
      model: model.model, maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
      inputNanoEur: Math.ceil(model.inputUsdPerMillion * input.eurPerUsdCeiling * 1000),
      outputNanoEur: Math.ceil(model.outputUsdPerMillion * input.eurPerUsdCeiling * 1000),
    }];
  }));
  const offers = Object.fromEntries(['discovery', 'author_ai', 'studio'].map(code => {
    const offer = input.offers?.[code];
    if (!offer || !integer(offer.dailyTokens, 100000000) || !integer(offer.monthlyTokens, 1000000000)
      || offer.monthlyTokens < offer.dailyTokens || !Number.isFinite(offer.dailyEur) || offer.dailyEur < 0 || offer.dailyEur > 1000
      || !Number.isFinite(offer.monthlyEur) || offer.monthlyEur < offer.dailyEur || offer.monthlyEur > 10000) throw new Error(`Invalid budget: ${code}`);
    return [code, { dailyTokens: offer.dailyTokens, monthlyTokens: offer.monthlyTokens,
      dailyNanoEur: Math.floor(offer.dailyEur * 1e9), monthlyNanoEur: Math.floor(offer.monthlyEur * 1e9) }];
  }));
  return { enabled: input.enabled, models, offers };
}

async function main() {
  const file = process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : 'config/ai-policy.json';
  const document = compileAiPolicy(JSON.parse(readFileSync(resolve(file), 'utf8')));
  if (!process.argv.includes('--apply')) { console.log('Configuration validée (aucune modification serveur).'); console.log(JSON.stringify(document, null, 2)); return; }
  const envFile = process.argv.includes('--env-file') ? process.argv[process.argv.indexOf('--env-file') + 1] : undefined;
  const env = { ...(envFile ? parseEnvironmentFile(readFileSync(resolve(envFile), 'utf8')) : {}), ...process.env };
  const url = new URL(env.SUPABASE_URL ?? '');
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') || url.pathname !== '/' || url.username || url.search)
    throw new Error('Hosted SUPABASE_URL required');
  const ref = process.argv.includes('--project-ref') ? process.argv[process.argv.indexOf('--project-ref') + 1] : '';
  if (!/^[a-z0-9]{20}$/.test(ref) || url.hostname !== `${ref}.supabase.co`)
    throw new Error('Explicit matching --project-ref required before applying');
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Supabase server credential required, never a publishable key');
  const response = await fetch(`${url.origin}/rest/v1/rpc/configure_ai_tokens`, {
    method: 'POST', redirect: 'error',
    headers: { apikey: key, ...(!key.startsWith('sb_secret_') ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_document: document }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Configuration refused (HTTP ${response.status}); verify migration and server permissions.`);
  console.log(`Configuration IA appliquée à ${url.hostname}. Version : ${await response.json()}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Configuration IA non appliquée. Vérifier le fichier, la migration et les identifiants serveur. Aucun secret affiché.'); process.exitCode = 1; });
}
