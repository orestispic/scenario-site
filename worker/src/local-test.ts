import { createLocalRuntime } from './localRuntime.ts';
type LocalRuntime = Awaited<ReturnType<typeof createLocalRuntime>>;
let localWorker: Promise<LocalRuntime> | null = null;

async function getLocalWorker() {
  localWorker ??= createLocalRuntime();
  return localWorker;
}

const localTestWorker = {
  async fetch(request: Request): Promise<Response> {
    const runtime = await getLocalWorker();
    const url = new URL(request.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname))
      return new Response(null, { status: 403 });
    if (url.pathname.startsWith('/_local/auth/v1/'))
      return runtime.auth.fetch(request);
    if (
      url.pathname === '/_local/admin/activation-keys' &&
      request.method === 'POST'
    ) {
      if (request.headers.get('x-scenario-local-admin') !== 'phase3-local-only')
        return Response.json({ code: 'local_admin_required' }, { status: 403 });
      const body = (await request.json()) as {
        selectionId?: unknown;
        maximumActivations?: unknown;
        expiresAt?: unknown;
      };
      if (
        typeof body.selectionId !== 'string' ||
        typeof body.maximumActivations !== 'number' ||
        !(body.expiresAt === null || typeof body.expiresAt === 'string')
      )
        return Response.json({ code: 'invalid_payload' }, { status: 400 });
      return Response.json(
        await runtime.billing.createLocalActivationKey({
          selectionId: body.selectionId,
          maximumActivations: body.maximumActivations,
          expiresAt: body.expiresAt,
        }),
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (
      url.pathname.startsWith('/_local/admin/activation-keys/') &&
      request.method === 'DELETE'
    ) {
      if (request.headers.get('x-scenario-local-admin') !== 'phase3-local-only')
        return Response.json({ code: 'local_admin_required' }, { status: 403 });
      const keyId = url.pathname.split('/').at(-1)!;
      await runtime.billing.revokeActivationKey({
        keyId,
        actorProfileId: 'local-admin',
      });
      return new Response(null, { status: 204 });
    }
    return runtime.worker.fetch(request);
  },
};

export default localTestWorker;
