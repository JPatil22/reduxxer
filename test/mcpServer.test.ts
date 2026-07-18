import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/mcpServer.js';

// The search_context handler clamps limit and token_budget through clamp() so a
// client (or a prompt-injected one) can't drive unbounded work. These lock the
// arithmetic — especially the hostile non-finite inputs.
test('clamp bounds ordinary values into [lo, hi]', () => {
  assert.equal(clamp(5, 1, 50), 5);
  assert.equal(clamp(0, 1, 50), 1, 'below the floor clamps up');
  assert.equal(clamp(9999, 1, 50), 50, 'above the ceiling clamps down');
  assert.equal(clamp(-3, 1, 200000), 1, 'negatives clamp to the floor');
});

test('clamp rejects non-finite hostile inputs (NaN, Infinity) to the low bound', () => {
  assert.equal(clamp(NaN, 1, 50), 1);
  assert.equal(clamp(Infinity, 1, 200000), 1);
  assert.equal(clamp(-Infinity, 1, 200000), 1);
});
