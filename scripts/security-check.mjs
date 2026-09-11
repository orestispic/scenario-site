import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const appMode = process.argv.includes('--app');
const roots = appMode
  ? [
      '../scenario-app-commercial/src',
      '../scenario-app-commercial/src-tauri/src',
    ]
  : ['worker/src', 'lib', 'app', 'supabase', 'scripts'];
let files = 0;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs|sql|json|rs)$/.test(path)) continue;
    const text = await readFile(path, 'utf8');
    files += 1;
    // Deliberately report only filenames, never the matched secret.
    assert.ok(
      !/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(text),
      `Private key: ${path}`,
    );
    assert.ok(
      !/(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{24,}/.test(
        text,
      ),
      `Provider secret: ${path}`,
    );
    if (
      /^(app|lib)[\\/]/.test(path) ||
      (appMode && path.includes('commercial'))
    ) {
      assert.ok(
        !/(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:token|session)/i.test(
          text,
        ),
        `Token persistence: ${path}`,
      );
      assert.ok(
        !/SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY|STRIPE_SECRET_KEY|OFFLINE_GRANT_PRIVATE_JWK|OPENAI_API_KEY|OPENAI_(?:SHORT_ACTION|PDF_IMPORT)_MODEL/.test(
          text,
        ),
        `Server config in client: ${path}`,
      );
    }
    if (appMode) {
      assert.ok(
        !/api\.openai\.com\/v1\/responses|OPENAI_API_KEY/.test(text),
        `Direct AI provider access in application: ${path}`,
      );
    }
  }
}
for (const root of roots) await scan(root);
console.log(`Security source checks passed (${files} files).`);
