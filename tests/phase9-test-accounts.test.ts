/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accountDefinitions } from '../scripts/phase9-provision-test-accounts.mjs';

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
