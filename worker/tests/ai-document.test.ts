import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiDocumentSchema, isAiEditorDocument } from '../src/aiDocument.ts';
const doc = { formatVersion: 1, title: 'Import', content: { type: 'doc', content: [
  { type: 'paragraph', attrs: { scenarioType: 'SCENE_HEADING' }, content: [{ type: 'text', text: 'INT. SALON - JOUR' }] },
] } };
test('AI PDF import is a native editor document, not just arbitrary JSON', () => {
  assert.equal(isAiEditorDocument(doc), true);
  assert.equal(isAiEditorDocument({ formatVersion: 1, title: 'bad', content: { scenes: [] } }), false);
  for (const node of [
    { type: 'image', src: 'https://attacker.invalid' },
    { ...doc.content.content[0], attrs: { scenarioType: 'unknown' } },
    { ...doc.content.content[0], content: [{ type: 'text', text: 'X', marks: [{ type: 'link' }] }] },
    { ...doc.content.content[0], content: [{ type: 'text', text: '' }] },
  ]) assert.equal(isAiEditorDocument({ ...doc, content: { type: 'doc', content: [node] } }), false);
  assert.equal(aiDocumentSchema.additionalProperties, false);
  assert.equal(aiDocumentSchema.properties.content.properties.type.enum[0], 'doc');
});
