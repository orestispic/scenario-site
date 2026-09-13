// Deliberately small import vocabulary: no HTML, URLs, marks or executable nodes.
const paragraphTypes = ['SCENE_HEADING', 'ACTION', 'CHARACTER', 'DIALOGUE', 'PARENTHETICAL', 'TRANSITION'];
export const aiDocumentSchema = {
  type: 'object', additionalProperties: false,
  required: ['formatVersion', 'title', 'content'],
  properties: {
    formatVersion: { type: 'integer', enum: [1] },
    title: { type: 'string' },
    content: {
      type: 'object', additionalProperties: false, required: ['type', 'content'],
      properties: {
        type: { type: 'string', enum: ['doc'] },
        content: {
          type: 'array', minItems: 1, maxItems: 10000,
          items: {
            type: 'object', additionalProperties: false, required: ['type', 'attrs', 'content'],
            properties: {
              type: { type: 'string', enum: ['paragraph'] },
              attrs: {
                type: 'object', additionalProperties: false, required: ['scenarioType'],
                properties: { scenarioType: { type: 'string', enum: paragraphTypes } },
              },
              content: {
                type: 'array', items: {
                  type: 'object', additionalProperties: false, required: ['type', 'text'],
                  properties: { type: { type: 'string', enum: ['text'] }, text: { type: 'string', minLength: 1 } },
                },
              },
            },
          },
        },
      },
    },
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}
export function isAiEditorDocument(value: unknown): boolean {
  if (!record(value) || value.formatVersion !== 1 || typeof value.title !== 'string' || !record(value.content)) return false;
  const doc = value.content;
  if (doc.type !== 'doc' || !keys(doc, ['type', 'content']) || !Array.isArray(doc.content) || !doc.content.length || doc.content.length > 10000) return false;
  return doc.content.every(node => record(node) && node.type === 'paragraph' && keys(node, ['type', 'attrs', 'content'])
    && record(node.attrs) && keys(node.attrs, ['scenarioType']) && paragraphTypes.includes(String(node.attrs.scenarioType))
    && Array.isArray(node.content) && node.content.every(text => record(text) && keys(text, ['type', 'text'])
      && text.type === 'text' && typeof text.text === 'string' && text.text.length > 0));
}
