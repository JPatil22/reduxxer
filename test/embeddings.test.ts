import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedText, embedTexts, setEmbeddingsEnabled, embeddingsAreEnabled } from '../src/embeddings.js';

test('disabling embeddings makes embed calls return empty without loading the model', async () => {
  assert.equal(embeddingsAreEnabled(), true);
  setEmbeddingsEnabled(false);
  try {
    // Must NOT trigger a model download/inference — just return empty.
    assert.deepEqual(await embedText('anything'), []);
    assert.deepEqual(await embedTexts(['a', 'b']), []);
  } finally {
    setEmbeddingsEnabled(true); // restore so other tests still use embeddings
  }
});
