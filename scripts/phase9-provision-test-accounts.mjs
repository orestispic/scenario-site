import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEnvironmentFile } from './phase9-preflight.mjs';

const ROLES = ['owner', 'editor', 'viewer'];

export function accountDefinitions(projectRef) {
  if (!/^[a-z0-9]{20}$/.test(projectRef))
    throw new Error('A valid 20-character Supabase project ref is required.');
  return ROLES.map((role) => ({
    role,
    email: `phase9-${role}-${projectRef}@example.com`,
    displayName: `Phase 9 ${role[0].toUpperCase()}${role.slice(1)}`,
  }));
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function adminHeaders(secretKey) {
  const headers = {
    Accept: 'application/json',
    apikey: secretKey,
    'Content-Type': 'application/json',
  };
  if (!secretKey.startsWith('sb_secret_'))
    headers.Authorization = `Bearer ${secretKey}`;
  return headers;
}

function credentialPrefix(role) {
  return `PHASE9_${role.toUpperCase()}`;
}

function serializeCredentials(accounts) {
  const lines = [
    '# Synthetic preproduction accounts. Never commit or share this file.',
  ];
  for (const account of accounts) {
    const prefix = credentialPrefix(account.role);
    lines.push(`${prefix}_EMAIL=${account.email}`);
    lines.push(`${prefix}_PASSWORD=${account.password}`);
    lines.push(`${prefix}_USER_ID=${account.userId}`);
  }
  return `${lines.join('\n')}\n`;
}

async function listUsers(baseUrl, headers) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `${baseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`,
      { headers },
    );
    if (!response.ok)
      throw new Error(`Supabase user listing failed with HTTP ${response.status}.`);
    const payload = await response.json();
    const pageUsers = Array.isArray(payload.users) ? payload.users : [];
    users.push(...pageUsers);
    if (pageUsers.length < 1000) return users;
  }
}

async function createUser(baseUrl, headers, definition, password) {
  const response = await fetch(`${baseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: definition.email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: definition.displayName,
        environment: 'preproduction',
        synthetic_account: true,
        intended_studio_role: definition.role,
      },
    }),
  });
  if (!response.ok)
    throw new Error(
      `Supabase ${definition.role} creation failed with HTTP ${response.status}.`,
    );
  const user = await response.json();
  if (typeof user.id !== 'string')
    throw new Error(`Supabase ${definition.role} creation returned no user id.`);
  return user.id;
}

export async function provisionTestAccounts({
  projectRef,
  environmentPath = '.env.phase9.local',
  credentialsPath = '.env.phase9.accounts.local',
}) {
  const environment = parseEnvironmentFile(
    readFileSync(resolve(environmentPath), 'utf8'),
  );
  const baseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/, '');
  const expectedUrl = `https://${projectRef}.supabase.co`;
  if (baseUrl !== expectedUrl)
    throw new Error(`Refusing project mismatch; expected ${expectedUrl}.`);
  const secretKey =
    environment.SUPABASE_SECRET_KEY?.trim() ||
    environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secretKey) throw new Error('A Supabase server key is required.');

  const definitions = accountDefinitions(projectRef);
  const headers = adminHeaders(secretKey);
  const remoteUsers = await listUsers(baseUrl, headers);
  const localPath = resolve(credentialsPath);
  const saved = existsSync(localPath)
    ? parseEnvironmentFile(readFileSync(localPath, 'utf8'))
    : {};

  for (const definition of definitions) {
    const existing = remoteUsers.find(
      (user) => user.email?.toLowerCase() === definition.email,
    );
    if (!existing) continue;
    const prefix = credentialPrefix(definition.role);
    if (
      saved[`${prefix}_EMAIL`] !== definition.email ||
      !saved[`${prefix}_PASSWORD`] ||
      saved[`${prefix}_USER_ID`] !== existing.id
    )
      throw new Error(
        `The ${definition.role} account already exists without matching local credentials; refusing to reset it.`,
      );
  }

  const accounts = [];
  for (const definition of definitions) {
    const prefix = credentialPrefix(definition.role);
    const existing = remoteUsers.find(
      (user) => user.email?.toLowerCase() === definition.email,
    );
    if (existing) {
      accounts.push({
        ...definition,
        password: saved[`${prefix}_PASSWORD`],
        userId: existing.id,
        status: 'existing',
      });
      continue;
    }
    const password = `${randomBytes(24).toString('base64url')}Aa1!`;
    const userId = await createUser(baseUrl, headers, definition, password);
    accounts.push({
      ...definition,
      password,
      userId,
      status: 'created',
    });
    writeFileSync(localPath, serializeCredentials(accounts), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  writeFileSync(localPath, serializeCredentials(accounts), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return accounts.map(({ role, status }) => ({ role, status }));
}

async function run() {
  const refIndex = process.argv.indexOf('--project-ref');
  const projectRef = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;
  if (!projectRef) throw new Error('--project-ref is required.');
  const result = await provisionTestAccounts({ projectRef });
  for (const account of result)
    console.log(`${account.role}: ${account.status}`);
  console.log('Credentials saved in the ignored local accounts file.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Provisioning failed.');
    process.exitCode = 1;
  });
