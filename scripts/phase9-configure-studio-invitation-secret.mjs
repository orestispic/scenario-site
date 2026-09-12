import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnvironmentFile } from './phase9-preflight.mjs';

const ENVIRONMENT_PATH = resolve('.env.phase9.local');
const SECRET_NAME = 'STUDIO_INVITATION_PEPPER';

function upsertEnvironmentValue(source, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  return pattern.test(source)
    ? source.replace(pattern, line)
    : `${source.replace(/\s*$/, '')}\n${line}\n`;
}

function run() {
  const source = readFileSync(ENVIRONMENT_PATH, 'utf8');
  const environment = parseEnvironmentFile(source);
  const projectIndex = process.argv.indexOf('--project-ref');
  const projectRef =
    projectIndex >= 0 ? process.argv[projectIndex + 1] : undefined;
  if (
    !projectRef ||
    environment.SUPABASE_URL !== `https://${projectRef}.supabase.co`
  )
    throw new Error('Refusing a project mismatch.');
  const configuration = readFileSync(
    resolve('wrangler.preproduction.toml'),
    'utf8',
  );
  if (!/name\s*=\s*"scenario-commercial-api-preproduction"/.test(configuration))
    throw new Error('Refusing a non-preproduction Worker configuration.');

  const secret =
    environment[SECRET_NAME]?.trim() ||
    randomBytes(48).toString('base64url');
  writeFileSync(
    ENVIRONMENT_PATH,
    upsertEnvironmentValue(source, SECRET_NAME, secret),
    { encoding: 'utf8', mode: 0o600 },
  );

  const executable =
    process.platform === 'win32'
      ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe')
      : 'npx';
  const argumentsList =
    process.platform === 'win32'
      ? [
          '/d',
          '/s',
          '/c',
          'npx.cmd wrangler secret put STUDIO_INVITATION_PEPPER --config wrangler.preproduction.toml',
        ]
      : [
          'wrangler',
          'secret',
          'put',
          SECRET_NAME,
          '--config',
          'wrangler.preproduction.toml',
        ];
  const result = spawnSync(
    executable,
    argumentsList,
    {
      cwd: process.cwd(),
      input: `${secret}\n`,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw new Error('Cloudflare rejected the invitation secret rotation.');
  console.log('Studio invitation secret configured for preproduction.');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Secret setup failed.');
  process.exitCode = 1;
}
