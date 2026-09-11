/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveSupabaseAdminKey,
  supabaseAdminHeaders,
} from '../src/supabaseAdmin.ts';

describe('Supabase server keys', () => {
  it('uses the current secret key without treating it as a bearer token', () => {
    const environment = {
      SUPABASE_SECRET_KEY: 'sb_secret_synthetic_test',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy.synthetic.test',
    };
    assert.equal(
      resolveSupabaseAdminKey(environment),
      'sb_secret_synthetic_test',
    );
    assert.deepEqual(supabaseAdminHeaders(environment), {
      Accept: 'application/json',
      apikey: 'sb_secret_synthetic_test',
    });
  });

  it('keeps legacy service_role JWT compatibility during migration', () => {
    const headers = supabaseAdminHeaders({
      SUPABASE_SERVICE_ROLE_KEY: 'legacy.synthetic.test',
    });
    assert.equal(headers.apikey, 'legacy.synthetic.test');
    assert.equal(headers.Authorization, 'Bearer legacy.synthetic.test');
  });

  it('fails closed when no server key is configured', () => {
    assert.throws(
      () => resolveSupabaseAdminKey({}),
      /Supabase server key is not configured/,
    );
  });
});
