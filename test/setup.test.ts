import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runInit } from '../src/setup.js';

test('runInit creates .mcp.json + CLAUDE.md rule for claude', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  runInit({ repoPath: repo, cliPath: 'X:/daemon/cli.js', clients: ['claude'] });

  const mcp = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers['context-daemon'], 'daemon server written');
  assert.equal(mcp.mcpServers['context-daemon'].args[0], 'X:/daemon/cli.js');
  assert.match(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8'), /search_context/);

  fs.rmSync(repo, { recursive: true, force: true });
});

test('runInit merges into existing .mcp.json and preserves other servers + CLAUDE.md content', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Notes\n\nkeep me\n');

  runInit({ repoPath: repo, cliPath: 'X:/daemon/cli.js', clients: ['claude'] });

  const mcp = JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.other, 'existing server preserved');
  assert.ok(mcp.mcpServers['context-daemon'], 'daemon added alongside');
  const claude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /keep me/, 'existing CLAUDE.md content preserved');
  assert.match(claude, /search_context/, 'rule appended');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('runInit is idempotent — the CLAUDE.md rule is not duplicated on re-run', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  runInit({ repoPath: repo, cliPath: 'X:/daemon/cli.js', clients: ['claude'] });
  runInit({ repoPath: repo, cliPath: 'X:/daemon/cli.js', clients: ['claude'] });

  const claude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
  const occurrences = (claude.match(/Finding code \(do this FIRST/g) || []).length;
  assert.equal(occurrences, 1, 'rule appears exactly once after two runs');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('runInit for cursor writes .cursor/mcp.json and an always-apply rule', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  runInit({ repoPath: repo, cliPath: 'X:/daemon/cli.js', clients: ['cursor'] });

  assert.ok(fs.existsSync(path.join(repo, '.cursor', 'mcp.json')));
  const rule = fs.readFileSync(path.join(repo, '.cursor', 'rules', 'use-context-daemon.mdc'), 'utf8');
  assert.match(rule, /alwaysApply: true/);
  assert.match(rule, /search_context/);

  fs.rmSync(repo, { recursive: true, force: true });
});
