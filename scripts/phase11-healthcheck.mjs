// Finite read-only check. No notification provider, credentials or payment.
import { performance } from 'node:perf_hooks';
const origin = 'https://scenario-commercial-api-preproduction.ore-picard.workers.dev';
let failed = false;
for (const path of ['/v1/config', '/v11/catalog']) {
  const start = performance.now();
  try {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const value = await response.json();
    const healthy = response.ok && (path === '/v1/config' ? value.environment === 'staging' : value.contractVersion === '2026-09-v11' && value.testMode === true);
    failed ||= !healthy;
    console.log(JSON.stringify({ event: 'beta.health', route: path, status: response.status, healthy,
      duration_ms: Math.round(performance.now() - start),
      request_id: /^[a-f0-9-]{36}$/.test(value.request_id ?? '') ? value.request_id : null }));
  } catch {
    failed = true;
    console.log(JSON.stringify({ event: 'beta.health', route: path, healthy: false, duration_ms: Math.round(performance.now() - start) }));
  }
}
process.exitCode = failed ? 2 : 0;
