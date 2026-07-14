import fs from 'node:fs';

/** One line of the per-call audit log (.context-daemon/requests.log). */
export interface RequestLogEntry {
  ts: string;
  client: string;
  query: string;
  chunks: number;
  naiveTokens: number;
  targetedTokens: number;
  savedTokens: number;
}

export interface StatsSummary {
  logPath: string;
  calls: number;
  totalNaiveTokens: number;
  totalTargetedTokens: number;
  totalSavedTokens: number;
  reductionPct: number;
  byClient: Array<{ client: string; calls: number; savedTokens: number }>;
  firstTs?: string;
  lastTs?: string;
  recent: RequestLogEntry[];
}

/** Reads the JSONL audit log, tolerating blank/partial lines (a call can be
 *  mid-append when stats is run). Returns [] if the log doesn't exist yet. */
export function readRequestLog(logPath: string): RequestLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }
  const out: RequestLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (typeof e.savedTokens === 'number') out.push(e as RequestLogEntry);
    } catch {
      // skip a malformed / half-written line
    }
  }
  return out;
}

export function summarizeRequests(logPath: string): StatsSummary {
  const entries = readRequestLog(logPath);
  let naive = 0;
  let targeted = 0;
  let saved = 0;
  const clientMap = new Map<string, { calls: number; savedTokens: number }>();
  for (const e of entries) {
    naive += e.naiveTokens || 0;
    targeted += e.targetedTokens || 0;
    saved += e.savedTokens || 0;
    const c = clientMap.get(e.client) ?? { calls: 0, savedTokens: 0 };
    c.calls += 1;
    c.savedTokens += e.savedTokens || 0;
    clientMap.set(e.client, c);
  }
  const byClient = [...clientMap.entries()]
    .map(([client, v]) => ({ client, ...v }))
    .sort((a, b) => b.savedTokens - a.savedTokens);
  return {
    logPath,
    calls: entries.length,
    totalNaiveTokens: naive,
    totalTargetedTokens: targeted,
    totalSavedTokens: saved,
    reductionPct: naive === 0 ? 0 : Math.round((saved / naive) * 100),
    byClient,
    firstTs: entries[0]?.ts,
    lastTs: entries[entries.length - 1]?.ts,
    recent: entries.slice(-10),
  };
}

/** Human-readable dashboard for the CLI `stats` command. */
export function renderStats(s: StatsSummary): string {
  if (s.calls === 0) {
    return `No search_context calls logged yet.\n(${s.logPath})\nUse the daemon from your AI tool, then run this again.`;
  }
  const n = (x: number) => x.toLocaleString();
  const lines: string[] = [];
  lines.push('context-daemon — token savings so far');
  lines.push('─'.repeat(44));
  lines.push(`  calls logged      : ${n(s.calls)}`);
  lines.push(`  naive (whole file): ${n(s.totalNaiveTokens)} tokens`);
  lines.push(`  actual (targeted) : ${n(s.totalTargetedTokens)} tokens`);
  lines.push(`  SAVED             : ${n(s.totalSavedTokens)} tokens  (${s.reductionPct}% reduction)`);
  if (s.firstTs && s.lastTs) lines.push(`  window            : ${s.firstTs.slice(0, 10)} → ${s.lastTs.slice(0, 10)}`);
  lines.push('');
  lines.push('  by client:');
  for (const c of s.byClient) {
    lines.push(`    ${c.client.padEnd(24)} ${String(c.calls).padStart(5)} calls   ${n(c.savedTokens).padStart(12)} saved`);
  }
  return lines.join('\n');
}
