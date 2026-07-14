import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { summarizeRequests } from '../src/stats.js';

test('summarizeRequests aggregates totals, reduction %, and per-client breakdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  const log = path.join(dir, 'requests.log');
  const lines = [
    { ts: '2026-01-01T00:00:00Z', client: 'claude-code', query: 'a', chunks: 3, naiveTokens: 1000, targetedTokens: 200, savedTokens: 800 },
    { ts: '2026-01-01T00:01:00Z', client: 'cursor', query: 'b', chunks: 2, naiveTokens: 500, targetedTokens: 100, savedTokens: 400 },
    { ts: '2026-01-01T00:02:00Z', client: 'claude-code', query: 'c', chunks: 1, naiveTokens: 500, targetedTokens: 300, savedTokens: 200 },
  ];
  // include a blank line and a half-written line to prove tolerance
  fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n') + '\n\n{"ts":"partial"\n');

  const s = summarizeRequests(log);
  assert.equal(s.calls, 3, 'malformed/blank lines ignored');
  assert.equal(s.totalNaiveTokens, 2000);
  assert.equal(s.totalTargetedTokens, 600);
  assert.equal(s.totalSavedTokens, 1400);
  assert.equal(s.reductionPct, 70);
  assert.equal(s.byClient[0].client, 'claude-code', 'highest-saving client first');
  assert.equal(s.byClient[0].savedTokens, 1000);
  assert.equal(s.byClient[0].calls, 2);
  assert.equal(s.byClient[1].client, 'cursor');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('summarizeRequests on a missing log returns zeros, not a crash', () => {
  const s = summarizeRequests(path.join(os.tmpdir(), 'no-such-dir-' + Date.now(), 'requests.log'));
  assert.equal(s.calls, 0);
  assert.equal(s.totalSavedTokens, 0);
  assert.equal(s.reductionPct, 0);
});
