// Offline, read-only verifier. Does NOT restore SQL or prove offsite backup health.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyBackup(rootPath) {
  const root = await realpath(rootPath);
  const inside = async (name) => {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(name) || isAbsolute(name) || name.split('/').includes('..')) throw new Error('Unsafe backup path');
    const path = await realpath(resolve(root, name));
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Backup path outside root');
    return path;
  };
  const manifestPath = await inside('manifest.json');
  if ((await stat(manifestPath)).size > 8 * 1024 * 1024) throw new Error('Manifest too large');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.environment !== 'staging' ||
      !Number.isFinite(Date.parse(manifest.capturedAt)) || !Array.isArray(manifest.versions) ||
      manifest.versions.length > 100_000 || !manifest.database) throw new Error('Invalid backup manifest');
  const verifyFile = async (entry) => {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) throw new Error('Invalid file metadata');
    const path = await inside(entry.file);
    if ((await stat(path)).size !== entry.bytes) throw new Error('Backup size mismatch');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== entry.sha256) throw new Error('Backup checksum mismatch');
  };
  await verifyFile(manifest.database);
  const versions = new Map();
  const paths = new Set([manifest.database.file]);
  for (const v of manifest.versions) {
    if (!v || typeof v.versionId !== 'string' || !v.versionId || typeof v.scenarioId !== 'string' || !v.scenarioId ||
        !(v.parentVersionId === null || typeof v.parentVersionId === 'string') || versions.has(v.versionId) || paths.has(v.file)) throw new Error('Invalid or duplicate version');
    versions.set(v.versionId, v); paths.add(v.file); await verifyFile(v);
  }
  const completed = new Set();
  for (const v of versions.values()) {
    const visiting = new Set(); let current = v;
    while (current && !completed.has(current.versionId)) {
      if (visiting.has(current.versionId)) throw new Error('Cyclic history');
      visiting.add(current.versionId);
      if (current.parentVersionId === null) break;
      const parent = versions.get(current.parentVersionId);
      if (!parent || parent.scenarioId !== current.scenarioId) throw new Error('Missing or cross-project parent');
      current = parent;
    }
    for (const id of visiting) completed.add(id);
  }
  // No paths, content, object keys or user identifiers in output.
  return { event: 'backup.integrity', valid: true, files: paths.size, versions: versions.size,
    databaseRestoreVerified: false, offsiteRestoreVerified: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Expected directory');
    console.log(JSON.stringify(await verifyBackup(process.argv[2])));
  } catch { console.error('Backup integrity check failed. No restore performed.'); process.exitCode = 2; }
}
