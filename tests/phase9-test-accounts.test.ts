/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accountDefinitions } from '../scripts/phase9-provision-test-accounts.mjs';
import { deterministicUuid } from '../scripts/phase9-provision-studio-fixture.mjs';

test('phase 9 synthetic accounts have fixed non-privileged identities', () => {
  const accounts = accountDefinitions('zblnsdyaoljnezxdidtx');
  assert.deepEqual(
    accounts.map(({ role }) => role),
    ['owner', 'editor', 'viewer'],
  );
  assert.equal(new Set(accounts.map(({ email }) => email)).size, 3);
  assert.ok(accounts.every(({ email }) => email.endsWith('@example.com')));
  assert.throws(() => accountDefinitions('another-project'));
});

test('phase 9 fixture identifiers are deterministic UUIDs', () => {
  assert.equal(
    deterministicUuid('zblnsdyaoljnezxdidtx:phase9:scenario:v1'),
    deterministicUuid('zblnsdyaoljnezxdidtx:phase9:scenario:v1'),
  );
  assert.match(
    deterministicUuid('zblnsdyaoljnezxdidtx:phase9:scenario:v1'),
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
