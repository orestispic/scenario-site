import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const site = process.cwd();
const appMode = process.argv.includes('--app');
const cwd = appMode ? resolve(site, '../scenario-app-commercial') : site;
const files = appMode
  ? [
      'src/App.tsx',
      'src/document/aiConfig.ts',
      'src/commercial/AccountLicensePanel.tsx',
      'src/commercial/authenticatedApi.ts',
      'src/commercial/aiApi.test.ts',
      'src/commercial/contractsV5.ts',
      'src/commercial/contractsV5.test.ts',
      'src/commercial/runtime.ts',
    ]
  : [
      'lib/commercial/contracts-v5.ts',
      'worker/src/aiProvider.ts',
      'worker/src/aiQuota.ts',
      'worker/src/index.ts',
      'worker/src/localAiProvider.ts',
      'worker/src/localAiQuotaRepository.ts',
      'worker/src/localBillingRepository.ts',
      'worker/src/localRuntime.ts',
      'worker/src/localTestRepository.ts',
      'worker/src/observability.ts',
      'worker/src/supabaseRepository.ts',
      'worker/src/types.ts',
      'worker/src/worker.ts',
      'worker/tests/phase5-ai.test.ts',
      'tests/phase5-migration.test.ts',
      'scripts/security-check.mjs',
      'scripts/test-local-runtime.mjs',
      'scripts/check-phase5-style.mjs',
    ];

for (const tool of ['oxlint', 'oxfmt']) {
  const packageDirectory = resolve(site, 'node_modules', tool);
  const manifest = JSON.parse(
    await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
  );
  const bin =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[tool];
  const formatFiles = appMode
    ? files.filter(
        (file) =>
          file !== 'src/App.tsx' &&
          file !== 'src/commercial/AccountLicensePanel.tsx',
      )
    : files;
  const args = tool === 'oxfmt' ? ['--check', ...formatFiles] : files;
  const result = spawnSync(
    process.execPath,
    [resolve(packageDirectory, bin), ...args],
    {
      cwd,
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  `Phase 5 targeted lint/format passed (${appMode ? 'application' : 'site/API'}).`,
);
