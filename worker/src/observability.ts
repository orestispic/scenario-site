export const API_ROUTES = new Set([
  '/v17/device-session/claim',
  '/v17/device-session/heartbeat',
  '/v17/device-session/release',
  '/v14/projects/:id/versions',
  '/v16/scenarios/:id/document',
  '/v11/catalog',
  '/v10/projects/:id/metadata',
  '/v9/projects',
  '/v9/projects/:id/sharing',
  '/v9/project-invitations/:id/respond',
  '/v15/contacts',
  '/v15/contact-requests',
  '/v15/contact-requests/:id/respond',
  '/v15/contacts/:id/remove',
  '/v3/entitlements',
  '/v1/config',
  '/v1/me',
  '/v1/entitlements',
  '/v1/devices',
  '/v1/devices/activate',
  '/v1/devices/deactivate',
  '/v2/devices/challenges',
  '/v2/devices/activate',
  '/v2/licenses/renew',
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
  '/v4/ai/usage',
  '/v5/scenarios',
  '/v5/scenarios/sync',
  '/v5/scenarios/:id/versions',
  '/v5/scenarios/:id/restore',
  '/v5/scenarios/:id/delete',
  '/v5/scenarios/:id/versions/:versionId/download',
  '/v6/studios',
  '/v6/studios/:id',
  '/v6/studios/:id/invitations',
  '/v6/studios/:id/invitations/:invitationId/revoke',
  '/v6/studios/:id/members/:profileId/role',
  '/v6/studios/:id/members/:profileId/remove',
  '/v6/studios/:id/events',
  '/v6/studio-invitations/accept',
  '/v6/studio-invitations/decline',
  '/v7/studios/:id/realtime/tickets',
  '/v7/studios/:id/realtime/connect',
  '/v7/studios/:id/realtime/heartbeat',
  '/v7/studios/:id/realtime/poll',
  '/v7/studios/:id/realtime/operations',
  '/v7/studios/:id/realtime/compact',
  '/v7/studios/:id/realtime/disconnect',
]);
const UUID =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export function normalizeApiRoute(pathname: string): string {
  if (new RegExp(`^/v14/projects/${UUID}/versions$`, 'i').test(pathname)) return '/v14/projects/:id/versions';
  if (new RegExp(`^/v16/scenarios/${UUID}/document$`, 'i').test(pathname)) return '/v16/scenarios/:id/document';
  if (new RegExp(`^/v10/projects/${UUID}/metadata$`, 'i').test(pathname)) return '/v10/projects/:id/metadata';
  if (API_ROUTES.has(pathname)) return pathname;
  if (new RegExp(`^/v9/projects/${UUID}/sharing$`, 'i').test(pathname)) return '/v9/projects/:id/sharing';
  if (new RegExp(`^/v9/project-invitations/${UUID}/respond$`, 'i').test(pathname)) return '/v9/project-invitations/:id/respond';
  if (new RegExp(`^/v15/contact-requests/${UUID}/respond$`, 'i').test(pathname)) return '/v15/contact-requests/:id/respond';
  if (new RegExp(`^/v15/contacts/${UUID}/remove$`, 'i').test(pathname)) return '/v15/contacts/:id/remove';
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
  if (new RegExp(`^/v6/studios/${UUID}$`, 'i').test(pathname))
    return '/v6/studios/:id';
  if (new RegExp(`^/v6/studios/${UUID}/invitations$`, 'i').test(pathname))
    return '/v6/studios/:id/invitations';
  if (
    new RegExp(`^/v6/studios/${UUID}/invitations/${UUID}/revoke$`, 'i').test(
      pathname,
    )
  )
    return '/v6/studios/:id/invitations/:invitationId/revoke';
  if (
    new RegExp(`^/v6/studios/${UUID}/members/${UUID}/role$`, 'i').test(pathname)
  )
    return '/v6/studios/:id/members/:profileId/role';
  if (
    new RegExp(`^/v6/studios/${UUID}/members/${UUID}/remove$`, 'i').test(
      pathname,
    )
  )
    return '/v6/studios/:id/members/:profileId/remove';
  if (new RegExp(`^/v6/studios/${UUID}/events$`, 'i').test(pathname))
    return '/v6/studios/:id/events';
  for (const action of [
    'tickets',
    'connect',
    'heartbeat',
    'poll',
    'operations',
    'compact',
    'disconnect',
  ])
    if (
      new RegExp(`^/v7/studios/${UUID}/realtime/${action}$`, 'i').test(pathname)
    )
      return `/v7/studios/:id/realtime/${action}`;
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
  studio?: 'none' | 'listed' | 'mutated' | 'replayed' | 'catchup';
  realtime?:
    | 'none'
    | 'ticketed'
    | 'connected'
    | 'heartbeat'
    | 'catchup'
    | 'applied'
    | 'conflict'
    | 'compacted'
    | 'closed'
    | 'rejected';
  connection_ref?: string;
  connection_count?: number;
  backlog_depth?: number;
  broadcast_latency_ms?: number;
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
        studio: metric.studio ?? 'none',
        realtime: metric.realtime ?? 'none',
        connection_ref: metric.connection_ref?.slice(0, 16) ?? 'none',
        connection_count: Math.max(
          0,
          Math.min(10_000, metric.connection_count ?? 0),
        ),
        backlog_depth: Math.max(
          0,
          Math.min(100_000, metric.backlog_depth ?? 0),
        ),
        broadcast_latency_ms: Math.max(
          0,
          Math.min(300_000, metric.broadcast_latency_ms ?? 0),
        ),
      }),
    );
  },
};
