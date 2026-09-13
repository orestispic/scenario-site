import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_PEPPERS = [
  'DEVICE_FINGERPRINT_PEPPER',
  'RATE_LIMIT_KEY_PEPPER',
  'ACTIVATION_KEY_PEPPER',
  'AI_IDEMPOTENCY_PEPPER',
  'CLOUD_IDEMPOTENCY_PEPPER',
  'STUDIO_INVITATION_PEPPER',
  'STUDIO_TICKET_PEPPER',
];
const PLACEHOLDER =
  /(replace|example\.invalid|project-ref|never[_ -]?expose|placeholder|generate[_ -]?in)/i;

export function parseEnvironmentFile(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        )
          value = value.slice(1, -1);
        return [key, value];
      }),
  );
}

function usable(value) {
  return (
    typeof value === 'string' && value.length > 0 && !PLACEHOLDER.test(value)
  );
}

function validHttpsUrl(value, hostnameCheck = () => true) {
  if (!usable(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !['localhost', '127.0.0.1'].includes(url.hostname) &&
      hostnameCheck(url.hostname)
    );
  } catch {
    return false;
  }
}

function checkOfflineKeys(environment) {
  try {
    const privateKey = JSON.parse(environment.OFFLINE_GRANT_PRIVATE_JWK);
    const publicKey = JSON.parse(environment.OFFLINE_GRANT_PUBLIC_JWK);
    return (
      privateKey.kty === 'EC' &&
      privateKey.crv === 'P-256' &&
      usable(privateKey.d) &&
      publicKey.kty === 'EC' &&
      publicKey.crv === 'P-256' &&
      !publicKey.d &&
      privateKey.x === publicKey.x &&
      privateKey.y === publicKey.y
    );
  } catch {
    return false;
  }
}

export function inspectPhase9Server(environment, preproductionConfig) {
  const checks = [];
  const add = (name, ready, action) => checks.push({ name, ready, action });

  add(
    'environnement staging',
    environment.SCENARIO_ENVIRONMENT === 'staging',
    'Définir SCENARIO_ENVIRONMENT=staging.',
  );
  add(
    'projet Supabase test',
    validHttpsUrl(environment.SUPABASE_URL, (host) =>
      host.endsWith('.supabase.co'),
    ) &&
      usable(environment.SUPABASE_ANON_KEY) &&
      (usable(environment.SUPABASE_SECRET_KEY) ||
        usable(environment.SUPABASE_SERVICE_ROLE_KEY)) &&
      environment.SUPABASE_ANON_KEY !==
        (environment.SUPABASE_SECRET_KEY ??
          environment.SUPABASE_SERVICE_ROLE_KEY),
    'Fournir l’URL, la clé publique et une clé secrète serveur Supabase de test isolée.',
  );
  const origins = (environment.API_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  add(
    'origines de préproduction',
    origins.length > 0 &&
      origins.every(
        (origin) =>
          origin === 'tauri://localhost' ||
          origin === 'http://tauri.localhost' ||
          validHttpsUrl(origin),
      ) &&
      !origins.includes('*'),
    'Remplacer les domaines .invalid par les domaines HTTPS réservés à la préproduction.',
  );
  add(
    'Stripe test uniquement',
    /^sk_test_[A-Za-z0-9_]+$/.test(environment.STRIPE_SECRET_KEY ?? '') &&
      /^whsec_[A-Za-z0-9_]+$/.test(environment.STRIPE_WEBHOOK_SECRET ?? '') &&
      !PLACEHOLDER.test(environment.STRIPE_SECRET_KEY ?? '') &&
      !PLACEHOLDER.test(environment.STRIPE_WEBHOOK_SECRET ?? ''),
    'Fournir uniquement sk_test_… et whsec_… provenant du compte Stripe de test.',
  );
  const pepperValues = REQUIRED_PEPPERS.map((key) => environment[key]);
  add(
    'secrets techniques séparés',
    pepperValues.every((value) => usable(value) && value.length >= 32) &&
      new Set(pepperValues).size === REQUIRED_PEPPERS.length,
    'Créer sept secrets aléatoires distincts d’au moins 32 caractères dans le coffre de test.',
  );
  add(
    'signature hors ligne P-256',
    usable(environment.OFFLINE_GRANT_KEY_ID) && checkOfflineKeys(environment),
    'Fournir une paire JWK P-256 cohérente réservée à la préproduction.',
  );
  add(
    'fournisseur IA de test',
    usable(environment.OPENAI_API_KEY),
    'Fournir la clé IA serveur et appliquer config/ai-policy.json ; aucun appel payant ne sera lancé par ce contrôle.',
  );
  add(
    'canal Studio Cloudflare',
    /name\s*=\s*"STUDIO_REALTIME_CHANNEL"/.test(preproductionConfig),
    'Créer le Durable Object de test puis ajouter sa liaison STUDIO_REALTIME_CHANNEL.',
  );
  add(
    'configuration Cloudflare privée',
    /workers_dev\s*=\s*false/.test(preproductionConfig) &&
      /preview_urls\s*=\s*false/.test(preproductionConfig) &&
      !/^\s*routes?\s*=/m.test(preproductionConfig),
    'Conserver workers.dev, previews et routes publiques désactivés.',
  );

  return { ready: checks.every((check) => check.ready), checks };
}

function run() {
  const argumentIndex = process.argv.indexOf('--env-file');
  const environmentPath = resolve(
    argumentIndex >= 0
      ? (process.argv[argumentIndex + 1] ?? '.env.phase9.local')
      : '.env.phase9.local',
  );
  let environment = {};
  let environmentFound = true;
  try {
    environment = parseEnvironmentFile(readFileSync(environmentPath, 'utf8'));
  } catch {
    environmentFound = false;
  }
  const config = readFileSync(resolve('wrangler.preproduction.toml'), 'utf8');
  const report = inspectPhase9Server(environment, config);
  if (!environmentFound)
    report.checks.unshift({
      name: 'fichier local protégé',
      ready: false,
      action:
        'Créer .env.phase9.local à partir de .env.example, sans le committer.',
    });
  const blocked = report.checks.filter((check) => !check.ready);
  console.log(
    blocked.length === 0
      ? 'Phase 9 serveur : PRÊTE pour une validation externe contrôlée.'
      : `Phase 9 serveur : BLOQUÉE (${blocked.length} élément(s) manquant(s)).`,
  );
  for (const check of blocked) console.log(`- ${check.action}`);
  process.exitCode = blocked.length === 0 ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run();
