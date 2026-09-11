/* oxlint-disable typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AiProviderError,
  OpenAiResponsesProvider,
  type AiProvider,
} from '../src/aiProvider.ts';
import { createLocalRuntime } from '../src/localRuntime.ts';
import type { RequestMetric } from '../src/observability.ts';

const DEVICE = 'phase5-device-fingerprint-000000000001';

async function configuredRuntime(
  options: { provider?: AiProvider; metrics?: RequestMetric[] } = {},
) {
  const runtime = await createLocalRuntime({
    ...(options.provider ? { aiProvider: options.provider } : {}),
    ...(options.metrics
      ? { telemetry: { record: (metric) => options.metrics!.push(metric) } }
      : {}),
  });
  const call = (
    path: string,
    profile: 'discovery' | 'author' | 'studio',
    body?: unknown,
    key = crypto.randomUUID(),
    fingerprint = DEVICE,
    version = '0.1.7',
  ) =>
    runtime.worker.fetch(
      new Request(`http://localhost${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer local-test:${profile}`,
          Origin: 'http://localhost:3000',
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Idempotency-Key': key,
                'X-Scenario-Client-Version': version,
                'X-Scenario-Device-Fingerprint': fingerprint,
                'X-Scenario-Platform': 'windows',
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  await call('/v1/devices/activate', 'author', {
    fingerprint: DEVICE,
    label: 'Auteur',
    platform: 'windows',
  });
  await call('/v1/devices/activate', 'studio', {
    fingerprint: `${DEVICE}-studio`,
    label: 'Studio',
    platform: 'windows',
  });
  return { runtime, call };
}

describe('IA serveur et quotas atomiques', () => {
  it('réserve une seule fois pour les retries et les appels concurrents', async () => {
    let calls = 0;
    const provider: AiProvider = {
      execute: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: 'text', text: 'Résultat' };
      },
    };
    const { runtime, call } = await configuredRuntime({ provider });
    const key = 'same-idempotency-key-0001';
    const request = () =>
      call(
        '/v4/ai/actions',
        'author',
        {
          kind: 'rewrite',
          instruction: 'Corrige.',
          text: 'Texte.',
        },
        key,
      );
    const responses = await Promise.all(Array.from({ length: 20 }, request));
    assert.equal(calls, 1);
    assert.equal(
      responses.filter((response) => response.status === 200).length >= 1,
      true,
    );
    assert.equal(runtime.repository.aiUsageEvents.length, 1);
    const replay = await request();
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as { replayed: boolean; result: unknown })
        .replayed,
      true,
    );
    assert.equal(runtime.repository.aiUsageEvents.length, 1);
    const conflict = await call(
      '/v4/ai/actions',
      'author',
      {
        kind: 'rewrite',
        instruction: 'Corrige.',
        text: 'Autre texte.',
      },
      key,
    );
    assert.equal(conflict.status, 409);
  });

  it('ne dépasse pas le quota court lors de réservations concurrentes', async () => {
    const { runtime, call } = await configuredRuntime();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        call(
          '/v4/ai/actions',
          'author',
          {
            kind: 'rewrite',
            instruction: 'Corrige.',
            text: `Texte ${index}`,
          },
          `unique-idempotency-key-${String(index).padStart(4, '0')}`,
        ),
      ),
    );
    assert.equal(
      responses.filter((response) => response.status === 200).length,
      6,
    );
    assert.equal(
      responses.filter((response) => response.status === 429).length,
      6,
    );
    assert.equal(runtime.repository.aiUsageEvents.length, 6);
  });

  it('refuse droits absents, appareil tiers, ancienne version et élévation cliente', async () => {
    const { call } = await configuredRuntime();
    await call('/v1/devices/activate', 'discovery', {
      fingerprint: DEVICE,
      label: 'Découverte',
      platform: 'windows',
    });
    assert.equal(
      (
        await call('/v4/ai/actions', 'discovery', {
          kind: 'rewrite',
          instruction: 'Corrige.',
          text: 'Texte.',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          '/v4/ai/actions',
          'studio',
          {
            kind: 'rewrite',
            instruction: 'Corrige.',
            text: 'Texte.',
          },
          crypto.randomUUID(),
          DEVICE,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          '/v4/ai/actions',
          'author',
          {
            kind: 'rewrite',
            instruction: 'Corrige.',
            text: 'Texte.',
          },
          crypto.randomUUID(),
          DEVICE,
          '0.0.9',
        )
      ).status,
      426,
    );
    assert.equal(
      (
        await call('/v4/ai/actions', 'author', {
          kind: 'rewrite',
          instruction: 'Corrige.',
          text: 'Texte.',
          role: 'admin',
          quota: 999,
        })
      ).status,
      400,
    );
  });

  it('libère les échecs certains et conserve les réponses incertaines à réconcilier', async () => {
    let mode: 'definitive' | 'uncertain' | 'success' = 'definitive';
    let calls = 0;
    const provider: AiProvider = {
      execute: async () => {
        calls += 1;
        if (mode !== 'success')
          throw new AiProviderError(mode, `provider_${mode}`, 'Échec simulé.');
        return { kind: 'text', text: 'OK' };
      },
    };
    const { call } = await configuredRuntime({ provider });
    const releasedKey = 'released-idempotency-key-0001';
    assert.equal(
      (
        await call(
          '/v4/ai/actions',
          'author',
          {
            kind: 'rewrite',
            instruction: 'Corrige.',
            text: 'Certain.',
          },
          releasedKey,
        )
      ).status,
      502,
    );
    assert.equal(
      (
        await call(
          '/v4/ai/actions',
          'author',
          {
            kind: 'rewrite',
            instruction: 'Corrige.',
            text: 'Certain.',
          },
          releasedKey,
        )
      ).status,
      409,
    );
    mode = 'success';
    assert.equal(
      (
        await call(
          '/v4/ai/actions',
          'author',
          {
            kind: 'rewrite',
            instruction: 'Corrige.',
            text: 'Certain.',
          },
          'replacement-idempotency-key-0001',
        )
      ).status,
      200,
    );

    mode = 'uncertain';
    const uncertainKey = 'uncertain-idempotency-key-0001';
    assert.equal(
      (
        await call(
          '/v4/ai/actions',
          'author',
          {
            kind: 'rewrite',
            instruction: 'Corrige.',
            text: 'Incertain.',
          },
          uncertainKey,
        )
      ).status,
      504,
    );
    const beforeRetryCalls = calls;
    assert.equal(
      (
        await call(
          '/v4/ai/actions',
          'author',
          {
            kind: 'rewrite',
            instruction: 'Corrige.',
            text: 'Incertain.',
          },
          uncertainKey,
        )
      ).status,
      202,
    );
    assert.equal(calls, beforeRetryCalls);
    const reconciliation = await call('/v4/ai/reconcile', 'author', {
      idempotencyKey: uncertainKey,
    });
    assert.equal(reconciliation.status, 200);
    assert.equal(
      ((await reconciliation.json()) as { status: string }).status,
      'uncertain',
    );
  });

  it('sépare le quota PDF, borne le format et refuse une session expirée', async () => {
    const metrics: RequestMetric[] = [];
    const { runtime, call } = await configuredRuntime({ metrics });
    const pdf = await call('/v4/ai/pdf-imports', 'author', {
      extractedText: 'INT. CUISINE - JOUR\nUne tasse.',
    });
    assert.equal(pdf.status, 200);
    const result = (await pdf.json()) as {
      operation: string;
      result: { scenarioJson: string };
    };
    assert.equal(result.operation, 'pdf_import');
    assert.equal(JSON.parse(result.result.scenarioJson).formatVersion, 1);
    assert.equal(
      runtime.repository.aiUsageEvents[0].quotaCode,
      'ai_pdf_import',
    );

    let now = Date.now();
    const expiring = await createLocalRuntime({}, () => now);
    const auth = (path: string, body: unknown) =>
      expiring.auth.fetch(
        new Request(`http://localhost/_local/auth/v1${path}`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    await auth('/signup', {
      email: 'expired-ai@example.invalid',
      password: 'password-fixture',
    });
    const session = (await (
      await auth('/token?grant_type=password', {
        email: 'expired-ai@example.invalid',
        password: 'password-fixture',
      })
    ).json()) as { access_token: string };
    now += 61_000;
    const expired = await expiring.worker.fetch(
      new Request('http://localhost/v4/ai/actions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'expired-session-key-000001',
          'X-Scenario-Client-Version': '0.1.7',
          'X-Scenario-Device-Fingerprint': DEVICE,
          'X-Scenario-Platform': 'windows',
        },
        body: JSON.stringify({
          kind: 'rewrite',
          instruction: 'Corrige.',
          text: 'Texte.',
        }),
      }),
    );
    assert.equal(expired.status, 401);
    assert.ok(!JSON.stringify(metrics).includes('Une tasse'));
  });
});

it('adapte Responses côté serveur sans stocker la réponse chez le fournisseur', async () => {
  let sent: Record<string, unknown> | null = null;
  const provider = new OpenAiResponsesProvider(
    {
      apiKey: 'server-fixture-key',
      shortActionModel: 'server-short-model',
      pdfImportModel: 'server-pdf-model',
      timeoutMs: 1_000,
    },
    async (_input, init) => {
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('Expected JSON body.');
      sent = JSON.parse(body);
      return Response.json({ output_text: 'Texte corrigé.' });
    },
  );
  assert.deepEqual(
    await provider.execute(
      {
        operation: 'short_action',
        request: { kind: 'rewrite', instruction: 'Corrige.', text: 'Texte.' },
      },
      '00000000-0000-4000-8000-000000000001',
    ),
    { kind: 'text', text: 'Texte corrigé.' },
  );
  assert.equal(sent!.model, 'server-short-model');
  assert.equal(sent!.store, false);
});
