/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeHostedSupabaseUrl,
  resolveSupabaseAdminKey,
  supabaseAdminHeaders,
} from '../src/supabaseAdmin.ts';
import { SupabaseRestRepository } from '../src/supabaseRepository.ts';

describe('Supabase server keys', () => {
  it('normalizes a copied hosted URL and rejects unsafe variants', () => {
    assert.equal(
      normalizeHostedSupabaseUrl(
        '  https://project-ref.supabase.co/\r\n',
      ),
      'https://project-ref.supabase.co',
    );
    assert.throws(
      () => normalizeHostedSupabaseUrl('http://project-ref.supabase.co'),
      /HTTPS URL required/,
    );
    assert.throws(
      () => normalizeHostedSupabaseUrl('https://example.invalid'),
      /HTTPS URL required/,
    );
  });

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

  it('reads public offers only through declared foreign keys', async () => {
    const requests: string[] = [];
    const repository = new SupabaseRestRepository(
      {
        SUPABASE_URL: 'https://project-ref.supabase.co',
        SUPABASE_SECRET_KEY: 'sb_secret_synthetic_test',
      } as never,
      async function (this: unknown, input) {
        assert.equal(this, undefined);
        requests.push(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        return Response.json([]);
      },
    );

    const configuration = await repository.getConfiguration();

    assert.equal(configuration.version, 'unconfigured');
    assert.equal(requests.length, 3);
    assert.match(requests[1]!, /offers!inner\(offer_code\)/);
    assert.match(
      requests[1]!,
      /offer_configuration_versions!inner\(status\)/,
    );
    assert.doesNotMatch(requests[1]!, /offer_entitlements\(|offer_quotas\(/);
  });
});
