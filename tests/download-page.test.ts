import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the Windows download page points to the stable GitHub release asset', async () => {
  const source = await readFile(new URL('../src/beta.tsx', import.meta.url), 'utf8');
  const vercel = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');
  assert.match(source, /\/releases\/latest\/download\/Scenario-Setup\.exe/);
  assert.match(source, /'\/telecharger': 'Télécharger Senario'/);
  assert.match(vercel, /"source": "\/telecharger"/);
  assert.match(source, /Automatiques et signées/);
});
