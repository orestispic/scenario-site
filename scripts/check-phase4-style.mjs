import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const site = process.cwd();
const appMode = process.argv.includes('--app');
const cwd = appMode ? resolve(site, '../scenario-app-commercial') : site;
const files = appMode
  ? [
      'AccountLicensePanel.tsx',
      'auth.ts',
      'authenticatedApi.ts',
      'session.ts',
      'session.test.ts',
      'tokenVault.ts',
      'tokenVault.test.ts',
      'offlineTrust.ts',
      'boundEntitlementCache.ts',
      'boundEntitlementCache.test.ts',
      'contractsV4.ts',
    ].map((file) => `src/commercial/${file}`)
  : [
      ...[
        'index',
        'jwt',
        'worker',
        'types',
        'distributedRateLimit',
        'observability',
        'localRuntime',
        'localAuthService',
        'local-test',
        'localTestRepository',
        'localBillingRepository',
        'stripe',
        'stripeWebhook',
        'supabaseRepository',
      ].map((file) => `worker/src/${file}.ts`),
      ...['phase4', 'phase4-e2e', 'phase4-jwks'].map(
        (file) => `worker/tests/${file}.test.ts`,
      ),
      'tests/phase4-security.test.ts',
      'lib/commercial/contracts-v4.ts',
      'scripts/security-check.mjs',
      'scripts/test-rate-limit-runtime.mjs',
      'scripts/test-local-runtime.mjs',
      'scripts/check-phase4-style.mjs',
    ];
for (const tool of ['oxlint', 'oxfmt']) {
  const packageDirectory = resolve(site, 'node_modules', tool);
  const manifest = JSON.parse(
    await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
  );
  const bin =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[tool];
  const args = tool === 'oxfmt' ? ['--check', ...files] : files;
  const result = spawnSync(
    process.execPath,
    [resolve(packageDirectory, bin), ...args],
    { cwd, stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  `Phase 4 targeted lint/format passed (${appMode ? 'application' : 'site/API'}).`,
);
