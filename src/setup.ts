import fs from 'node:fs';
import path from 'node:path';

/** The instruction that makes an AI assistant actually prefer the daemon over
 *  grepping and reading whole files. Without this nudge the tool is available
 *  but unused — the single biggest reason savings never materialize. */
export const DAEMON_RULE = `## Finding code (do this FIRST — it saves tokens)

Large files are monoliths — do NOT grep and read whole files to locate code.
When the \`context-daemon\` MCP server is connected, ALWAYS call its
\`search_context\` tool first: describe what you want in plain language (e.g.
"where auth is handled", "the function that validates URLs"). It returns just
the relevant functions instead of whole files. Only read a full file when
search_context returns nothing useful, or you genuinely need the whole file's
top-level wiring.`;

export type Client = 'claude' | 'cursor';

export interface InitOptions {
  repoPath: string;
  cliPath: string; // absolute path to this cli.js, so configs launch the right daemon
  clients: Client[];
}

/** Forward-slash paths so the generated JSON is valid and portable on Windows
 *  (backslashes would be JSON escape sequences). */
function fwd(p: string): string {
  return p.split(path.sep).join('/');
}

function mcpServerEntry(cliPath: string, repoPath: string) {
  return { command: 'node', args: [fwd(cliPath), 'mcp', fwd(repoPath)] };
}

/** Adds/updates the context-daemon entry in an .mcp.json, preserving any other
 *  servers already configured there. Never clobbers an existing file's other
 *  contents. */
function upsertMcpJson(file: string, cliPath: string, repoPath: string): string {
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      cfg = {};
    }
  }
  if (!cfg.mcpServers) cfg.mcpServers = {};
  const already = Object.prototype.hasOwnProperty.call(cfg.mcpServers, 'context-daemon');
  cfg.mcpServers['context-daemon'] = mcpServerEntry(cliPath, repoPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return already ? 'updated' : existed ? 'merged into existing' : 'created';
}

/** Appends the "use search_context first" rule to the repo's CLAUDE.md, unless
 *  it's already there. Creates the file if missing. */
function ensureClaudeMdRule(repoPath: string): string {
  const file = path.join(repoPath, 'CLAUDE.md');
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    if (/search_context/.test(content)) return 'already present';
    fs.writeFileSync(file, content.trimEnd() + '\n\n' + DAEMON_RULE + '\n');
    return 'appended';
  }
  fs.writeFileSync(file, `# Project guide\n\n${DAEMON_RULE}\n`);
  return 'created';
}

function ensureCursorRule(repoPath: string): string {
  const file = path.join(repoPath, '.cursor', 'rules', 'use-context-daemon.mdc');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body =
    `---\ndescription: Prefer context-daemon search_context for finding code in this repo\nalwaysApply: true\n---\n\n` +
    DAEMON_RULE +
    '\n';
  fs.writeFileSync(file, body);
  return 'created';
}

/** Wires the daemon into a repo for the requested client(s). Returns a list of
 *  human-readable "what happened" lines for the CLI to print. */
export function runInit(opts: InitOptions): string[] {
  const { repoPath, cliPath, clients } = opts;
  const report: string[] = [];
  if (clients.includes('claude')) {
    report.push(`.mcp.json (Claude Code)          : ${upsertMcpJson(path.join(repoPath, '.mcp.json'), cliPath, repoPath)}`);
    report.push(`CLAUDE.md "use it first" rule    : ${ensureClaudeMdRule(repoPath)}`);
  }
  if (clients.includes('cursor')) {
    report.push(`.cursor/mcp.json (Cursor)        : ${upsertMcpJson(path.join(repoPath, '.cursor', 'mcp.json'), cliPath, repoPath)}`);
    report.push(`.cursor rule                     : ${ensureCursorRule(repoPath)}`);
  }
  return report;
}
