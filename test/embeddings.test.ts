import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  embedText,
  embedTexts,
  setEmbeddingsEnabled,
  embeddingsAreEnabled,
  withInferenceLockForTests,
} from '../src/embeddings.js';

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

test('inference lock serializes concurrent tasks (at most one runs at a time)', async () => {
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const makeTask = (i: number) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    order.push(i);
    active--;
    return i;
  };
  // Submit five at once; the lock must run them one-at-a-time, in order.
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) => withInferenceLockForTests(makeTask(i))));
  assert.equal(maxActive, 1, 'never more than one inference in flight at once');
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.deepEqual(order, [0, 1, 2, 3, 4], 'tasks run in submission order (FIFO)');
});

test('inference lock keeps working after a task throws', async () => {
  await assert.rejects(withInferenceLockForTests(async () => {
    throw new Error('boom');
  }));
  // A failed inference must not wedge the chain for everyone after it.
  const ok = await withInferenceLockForTests(async () => 42);
  assert.equal(ok, 42, 'the lock still serves calls after one threw');
});
