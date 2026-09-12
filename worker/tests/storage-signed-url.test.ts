/* oxlint-disable typescript/no-floating-promises */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSupabaseSignedDownloadUrl, SupabaseScenarioObjectStorage } from '../src/cloudSync.ts';
import type { WorkerEnvironment } from '../src/types.ts';

test('Supabase relative signed URLs retain the storage/v1 gateway prefix', () => {
  const expected = 'https://test.supabase.co/storage/v1/object/sign/private/file?token=synthetic';
  for (const input of ['/object/sign/private/file?token=synthetic', '/storage/v1/object/sign/private/file?token=synthetic', expected])
    assert.equal(resolveSupabaseSignedDownloadUrl('https://test.supabase.co', input, 'private/file'), expected);
});
test('signed URLs cannot redirect to a different origin or object', () => {
  for (const input of ['https://other.invalid/storage/v1/object/sign/private/file?token=synthetic', '/object/sign/private/other?token=synthetic', '/object/sign/private/file', '//other.invalid/object/sign/private/file?token=synthetic'])
    assert.throws(() => resolveSupabaseSignedDownloadUrl('https://test.supabase.co', input, 'private/file'), /URL temporaire invalide/);
});
test('storage adapter returns a usable gateway URL rather than a project-root 404', async () => {
  const storage = new SupabaseScenarioObjectStorage({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' } as WorkerEnvironment, 'private', async () => Response.json({ signedURL: '/object/sign/private/file?token=synthetic' }));
  const grant = await storage.temporaryDownload({ key: 'file', profileId: 'profile', scenarioId: 'scenario', expiresInSeconds: 60 });
  assert.equal(grant.url, 'https://test.supabase.co/storage/v1/object/sign/private/file?token=synthetic');
  assert.equal(grant.operation, 'download');
});
