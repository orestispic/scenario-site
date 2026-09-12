import type {
  AiActionRequest,
  AiActionResult,
  AiOperation,
  AiPdfImportResult,
} from '../../lib/commercial/contracts-v5.ts';

export type AiProviderInput =
  | { operation: 'short_action'; request: AiActionRequest }
  | { operation: 'pdf_import'; request: { extractedText: string } };

export type AiProviderResult = AiActionResult | AiPdfImportResult;

export interface AiProvider {
  execute(input: AiProviderInput, requestId: string): Promise<AiProviderResult>;
}

export class AiProviderError extends Error {
  constructor(
    readonly certainty: 'definitive' | 'uncertain',
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export class UnavailableAiProvider implements AiProvider {
  async execute(): Promise<AiProviderResult> {
    throw new AiProviderError(
      'definitive',
      'ai_provider_unavailable',
      'Le fournisseur IA de test n’est pas configuré.',
    );
  }
}

type OpenAiConfiguration = {
  apiKey: string;
  shortActionModel: string;
  pdfImportModel: string;
  timeoutMs: number;
};

function assertConfiguration(configuration: OpenAiConfiguration): void {
  if (!configuration.apiKey.trim())
    throw new Error('OpenAI server key required');
  if (
    !configuration.shortActionModel.trim() ||
    !configuration.pdfImportModel.trim()
  )
    throw new Error('OpenAI server models required');
  if (
    !Number.isSafeInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < 1_000 ||
    configuration.timeoutMs > 300_000
  )
    throw new Error('Invalid AI timeout configuration');
}

function outputText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (typeof value.output_text === 'string' && value.output_text.trim())
    return value.output_text.trim();
  if (!Array.isArray(value.output)) return null;
  const text = value.output
    .flatMap((item) => {
      if (
        !item ||
        typeof item !== 'object' ||
        !Array.isArray((item as { content?: unknown }).content)
      )
        return [];
      return (item as { content: unknown[] }).content.flatMap((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? [(part as { text: string }).text]
          : [],
      );
    })
    .join('');
  return text.trim() || null;
}

function responseFormat(
  input: AiProviderInput,
): Record<string, unknown> | undefined {
  if (
    input.operation === 'short_action' &&
    input.request.kind === 'translate'
  ) {
    return {
      type: 'json_schema',
      name: 'scenario_translation',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['translations'],
        properties: {
          translations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'text'],
              properties: {
                index: { type: 'integer' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
    };
  }
  if (input.operation === 'pdf_import') {
    return {
      type: 'json_schema',
      name: 'scenario_document',
      strict: false,
      schema: {
        type: 'object',
        required: ['formatVersion', 'title', 'content'],
        properties: {
          formatVersion: { type: 'integer', const: 1 },
          title: { type: 'string' },
          content: { type: 'object' },
          characters: { type: 'array', items: { type: 'string' } },
          locations: { type: 'array', items: { type: 'string' } },
          times: { type: 'array', items: { type: 'string' } },
          coverPage: { type: 'object' },
          coverPageHidden: { type: 'boolean' },
          comments: { type: 'array' },
          savedAt: { type: 'string' },
        },
      },
    };
  }
  return undefined;
}

function providerInstructions(input: AiProviderInput): string {
  if (input.operation === 'pdf_import')
    return 'Convertis le texte extrait en document Scénario JSON. Préserve le texte et l’ordre. Classe chaque paragraphe de scénario et renvoie uniquement le JSON demandé.';
  if (input.request.kind === 'translate')
    return `Traduis chaque bloc vers ${input.request.targetLanguage}. Préserve les index, l’ordre, les noms propres et les conventions de scénario. Renvoie uniquement le JSON demandé.`;
  return 'Tu aides à réécrire un paragraphe de scénario. Respecte la demande de l’auteur et renvoie uniquement le texte final.';
}

function providerInput(input: AiProviderInput): string {
  if (input.operation === 'pdf_import') return input.request.extractedText;
  if (input.request.kind === 'translate')
    return JSON.stringify(input.request.segments);
  return `${input.request.instruction}\n\n${input.request.text}`;
}

/** Server-only OpenAI Responses adapter. It is never imported by the local entry point. */
export class OpenAiResponsesProvider implements AiProvider {
  constructor(
    private readonly configuration: OpenAiConfiguration,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    assertConfiguration(configuration);
  }

  async execute(
    input: AiProviderInput,
    requestId: string,
  ): Promise<AiProviderResult> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.configuration.timeoutMs,
    );
    const format = responseFormat(input);
    try {
      const response = await this.fetcher(
        'https://api.openai.com/v1/responses',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.configuration.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model:
              input.operation === 'pdf_import'
                ? this.configuration.pdfImportModel
                : this.configuration.shortActionModel,
            instructions: providerInstructions(input),
            input: providerInput(input),
            store: false,
            metadata: {
              scenario_request_id: requestId,
              scenario_operation: input.operation,
            },
            ...(format ? { text: { format } } : {}),
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new AiProviderError(
          response.status >= 500 || response.status === 429
            ? 'uncertain'
            : 'definitive',
          'ai_provider_rejected',
          'Le fournisseur IA a refusé la demande.',
        );
      }
      const text = outputText(await response.json());
      if (!text)
        throw new AiProviderError(
          'uncertain',
          'ai_provider_empty',
          'Réponse IA incomplète.',
        );
      if (input.operation === 'pdf_import')
        return { kind: 'scenario_json', scenarioJson: text };
      if (input.request.kind === 'rewrite') return { kind: 'text', text };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new AiProviderError(
          'uncertain',
          'ai_provider_invalid',
          'Traduction IA invalide.',
        );
      }
      const translations = (parsed as { translations?: unknown }).translations;
      if (!Array.isArray(translations))
        throw new AiProviderError(
          'uncertain',
          'ai_provider_invalid',
          'Traduction IA invalide.',
        );
      return {
        kind: 'translations',
        translations: translations as Array<{ index: number; text: string }>,
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError(
        'uncertain',
        'ai_provider_unavailable',
        'Fournisseur IA temporairement indisponible.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function operationOf(input: AiProviderInput): AiOperation {
  return input.operation;
}
