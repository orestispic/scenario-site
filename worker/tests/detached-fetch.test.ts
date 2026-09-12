/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detachedFetch } from '../src/detachedFetch.ts';

test('detached fetch never binds an adapter instance to the native function', async () => {
  const response = await detachedFetch(
    async function (this: unknown, input) {
      assert.equal(this, undefined);
      return Response.json({
        input:
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input,
      });
    },
    'https://example.invalid/test',
  );
  assert.deepEqual(await response.json(), {
    input: 'https://example.invalid/test',
  });
});
