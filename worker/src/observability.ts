export const API_ROUTES = new Set([
  '/v3/entitlements',
  '/v1/config',
  '/v1/me',
  '/v1/entitlements',
  '/v1/devices',
  '/v1/devices/activate',
  '/v1/devices/deactivate',
  '/v1/usage',
  '/v1/auth/logout',
  '/v2/billing',
  '/v2/checkout/sessions',
  '/v2/billing/portal-sessions',
  '/v2/stripe/webhook',
  '/v2/activation-keys/status',
  '/v2/activation-keys/redeem',
  '/v2/activation-keys/revoke',
  '/v4/ai/actions',
  '/v4/ai/pdf-imports',
  '/v4/ai/reconcile',
  '/v5/scenarios',
  '/v5/scenarios/sync',
  '/v5/scenarios/:id/versions',
  '/v5/scenarios/:id/restore',
  '/v5/scenarios/:id/delete',
  '/v5/scenarios/:id/versions/:versionId/download',
]);
const UUID =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export function normalizeApiRoute(pathname: string): string {
  if (API_ROUTES.has(pathname)) return pathname;
  if (new RegExp(`^/v5/scenarios/${UUID}/versions$`, 'i').test(pathname))
    return '/v5/scenarios/:id/versions';
  if (new RegExp(`^/v5/scenarios/${UUID}/restore$`, 'i').test(pathname))
    return '/v5/scenarios/:id/restore';
  if (new RegExp(`^/v5/scenarios/${UUID}/delete$`, 'i').test(pathname))
    return '/v5/scenarios/:id/delete';
  if (
    new RegExp(`^/v5/scenarios/${UUID}/versions/${UUID}/download$`, 'i').test(
      pathname,
    )
  )
    return '/v5/scenarios/:id/versions/:versionId/download';
  return 'unknown';
}
export interface RequestMetric {
  request_id: string;
  route: string;
  method: string;
  status: number;
  duration_ms: number;
  outcome: 'ok' | 'rejected' | 'unavailable';
  webhook: 'none' | 'processed' | 'replayed' | 'failed';
  ai?: 'none' | 'succeeded' | 'replayed' | 'released' | 'uncertain';
  cloud?: 'none' | 'synced' | 'replayed' | 'conflict' | 'restored' | 'deleted';
}
export interface Telemetry {
  record(metric: RequestMetric): void;
}
/** Allowlist at the sink as well as the call site; never serialize request/error objects. */
export const structuredTelemetry: Telemetry = {
  record(metric) {
    console.info(
      JSON.stringify({
        event: 'api.request',
        request_id: metric.request_id,
        route: API_ROUTES.has(metric.route) ? metric.route : 'unknown',
        method: ['GET', 'POST', 'OPTIONS'].includes(metric.method)
          ? metric.method
          : 'other',
        status: metric.status,
        duration_ms: metric.duration_ms,
        outcome: metric.outcome,
        webhook: metric.webhook,
        ai: metric.ai ?? 'none',
        cloud: metric.cloud ?? 'none',
      }),
    );
  },
};
