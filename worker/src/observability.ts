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
]);
export interface RequestMetric {
  request_id: string;
  route: string;
  method: string;
  status: number;
  duration_ms: number;
  outcome: 'ok' | 'rejected' | 'unavailable';
  webhook: 'none' | 'processed' | 'replayed' | 'failed';
  ai?: 'none' | 'succeeded' | 'replayed' | 'released' | 'uncertain';
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
      }),
    );
  },
};
