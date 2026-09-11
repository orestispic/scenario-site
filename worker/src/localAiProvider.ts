import type {
  AiProvider,
  AiProviderInput,
  AiProviderResult,
} from './aiProvider.ts';

/** Deterministic, local-only provider. It performs no network request. */
export class DeterministicLocalAiProvider implements AiProvider {
  async execute(input: AiProviderInput): Promise<AiProviderResult> {
    if (input.operation === 'pdf_import') {
      const lines = input.request.extractedText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 20);
      return {
        kind: 'scenario_json',
        scenarioJson: JSON.stringify({
          formatVersion: 1,
          title: 'Import local simulé',
          content: {
            type: 'doc',
            content: lines.map((text) => ({
              type: 'paragraph',
              attrs: { scenarioType: 'ACTION' },
              content: [{ type: 'text', text }],
            })),
          },
          characters: [],
          locations: [],
          times: [],
          coverPage: {},
          coverPageHidden: false,
          comments: [],
          savedAt: '2026-01-01T00:00:00.000Z',
        }),
      };
    }
    if (input.request.kind === 'translate') {
      const targetLanguage = input.request.targetLanguage;
      return {
        kind: 'translations',
        translations: input.request.segments.map(({ index, text }) => ({
          index,
          text: `[${targetLanguage}] ${text}`,
        })),
      };
    }
    return {
      kind: 'text',
      text: `[simulation IA] ${input.request.text.trim()}`,
    };
  }
}
