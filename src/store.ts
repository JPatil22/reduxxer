import fs from 'node:fs';
import path from 'node:path';
import { CodeChunk, FileRecord, SearchLogEntry } from './types.js';
import { estimateTokens } from './tokens.js';
import { embedText, cosineSimilarity, EMBEDDING_MODEL } from './embeddings.js';

interface IndexSnapshot {
  version: 1;
  embeddingModel: string;
  files: FileRecord[];
  chunks: CodeChunk[];
}

const SEARCH_LOG_LIMIT = 200;

/**
 * In-memory index. Holds the "cheat sheet" of the repo: one chunk per
 * function/class/interface, keyed by file + symbol name. Re-indexing a
 * single file only touches that file's chunks, not the whole store.
 */
export class IndexStore {
  private chunks = new Map<string, CodeChunk>();
  private files = new Map<string, FileRecord>();
  private searchLog: SearchLogEntry[] = [];
  private totalNaiveTokens = 0;
  private totalTargetedTokens = 0;

  getFileHash(filePath: string): string | undefined {
    return this.files.get(filePath)?.hash;
  }

  upsertFile(filePath: string, hash: string, chunks: CodeChunk[], content: string): void {
    const old = this.files.get(filePath);
    if (old) {
      for (const id of old.chunkIds) this.chunks.delete(id);
    }
    const chunkIds: string[] = [];
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
      chunkIds.push(chunk.id);
    }
    this.files.set(filePath, { filePath, hash, chunkIds, content });
  }

  removeFile(filePath: string): void {
    const old = this.files.get(filePath);
    if (old) {
      for (const id of old.chunkIds) this.chunks.delete(id);
      this.files.delete(filePath);
    }
  }

  allChunks(): CodeChunk[] {
    return [...this.chunks.values()];
  }

  /** Content words from a query — drops short tokens and common filler so a
   *  single letter like "a" in "render a chart" can't match every chunk and
   *  inflate lexical relevance. */
  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length >= 3 && !IndexStore.STOPWORDS.has(t));
  }

  /** Lexical relevance score: keyword hits normalized by chunk size, with a
   *  bonus for symbol-name matches and a penalty for whole-file fallback
   *  chunks. Returns 0 for no match. */
  private lexicalScore(query: string, chunk: CodeChunk): number {
    const terms = this.queryTerms(query);
    const haystack = (chunk.symbolName + ' ' + chunk.code).toLowerCase();
    let rawScore = 0;
    for (const term of terms) {
      if (chunk.symbolName.toLowerCase().includes(term)) rawScore += 5;
      rawScore += haystack.split(term).length - 1;
    }
    const sizeFactor = Math.sqrt(Math.max(chunk.code.length, 1));
    const kindPenalty = chunk.kind === 'file' ? 0.3 : 1;
    return (rawScore / sizeFactor) * kindPenalty;
  }

  /**
   * Relevance search blending semantic similarity (embeddings, when a chunk
   * has one) with the lexical score as a boost — lexical alone misses
   * synonyms/paraphrases ("ship an order" vs "notifyOrderShipped"), and
   * semantic alone can miss exact identifier matches, so combine both.
   *
   * Also does a one-hop dependency expansion on the top match: a chunk
   * like processPayment returned in isolation is missing the context of
   * what validateCard/updateLedger (the functions it calls) actually do.
   * Those get appended after the ranked matches, up to a small cap, so
   * results stay grounded in what the query actually matched.
   */
  async search(query: string, limit = 5): Promise<CodeChunk[]> {
    const chunks = this.allChunks();
    const hasEmbeddings = chunks.some((c) => c.embedding);
    const queryEmbedding = hasEmbeddings ? await embedText(query) : null;
    const normalizedQuery = query.toLowerCase().trim();
    const terms = this.queryTerms(query);

    const scored = chunks.map((chunk) => {
      const lexical = this.lexicalScore(query, chunk);
      const semantic =
        queryEmbedding && chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0;
      // Semantic similarity (0-1) drives ranking; lexical score is a smaller
      // additive boost so exact identifier/keyword matches still float up.
      const score = semantic + lexical * 0.05;

      // Relevance gate — a chunk counts as a real match if ANY of:
      //  - the whole query is a substring of the symbol name (exact lookup);
      //  - it clears the semantic floor (strong meaning match);
      //  - it contains at least two distinct query content-words (real
      //    lexical overlap concentrated in one chunk, which rescues genuine
      //    matches that score low semantically in tiny repos).
      // A query for functionality that doesn't exist shares at most one
      // incidental word and has low similarity, so it clears none of these
      // and returns nothing instead of the nearest wrong chunk.
      const haystack = (chunk.symbolName + ' ' + chunk.code).toLowerCase();
      const distinctTerms = terms.filter((t) => haystack.includes(t)).length;
      const nameHit = normalizedQuery.length > 0 && chunk.symbolName.toLowerCase().includes(normalizedQuery);
      const relevant =
        nameHit || (queryEmbedding !== null && semantic >= IndexStore.SEMANTIC_FLOOR) || distinctTerms >= 2;
      return { chunk, score, relevant };
    });

    const results = scored
      .filter((s) => s.relevant)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.chunk);

    return this.expandWithReferences(results);
  }

  // Minimum cosine similarity for a chunk to count as a semantic match. A
  // chunk below this can still match if a real query word appears in it
  // (see search) — semantic alone can't tell a genuine match in a tiny repo
  // from an absent query, but "no query word present AND low similarity"
  // reliably means nothing relevant.
  private static readonly SEMANTIC_FLOOR = 0.3;

  // Common filler words dropped from lexical matching so they don't create
  // spurious hits (a query is natural language, not just identifiers).
  private static readonly STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'was', 'this', 'that', 'with', 'from', 'what', 'where', 'when',
    'why', 'how', 'does', 'did', 'has', 'have', 'its', 'you', 'your', 'into', 'not', 'but', 'can',
    'will', 'all', 'any', 'out', 'get', 'got', 'let', 'via', 'per', 'off',
  ]);

  private static readonly RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.py'];
  // Directory-as-module entry points: JS/TS resolve `./dir` to dir/index.*,
  // Python resolves a package to dir/__init__.py.
  private static readonly INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', '__init__.py'];

  /** Resolves a cross-file ref ("<path-without-ext>::<name>") to an actual
   *  indexed chunk by trying each file extension and directory entry point,
   *  since the exact extension isn't known when imports are recorded at
   *  parse time. */
  private resolveExternalRef(ref: string): CodeChunk | undefined {
    const sep = ref.lastIndexOf('::');
    if (sep < 0) return undefined;
    const prefix = ref.slice(0, sep);
    const name = ref.slice(sep + 2);
    for (const ext of IndexStore.RESOLVE_EXTS) {
      const direct = this.chunks.get(`${prefix}${ext}::${name}`);
      if (direct) return direct;
    }
    for (const indexFile of IndexStore.INDEX_FILES) {
      const idx = this.chunks.get(`${path.join(prefix, indexFile)}::${name}`);
      if (idx) return idx;
    }
    return undefined;
  }

  /** Appends the top result's direct dependencies — both same-file
   *  (`references`) and imported-from-another-file (`externalRefs`) — if not
   *  already present, capped so expansion can't dwarf the real matches. This
   *  is what lets the daemon hand over an imported function alongside the
   *  function that uses it, instead of leaving the caller to go read the
   *  other file itself. */
  private expandWithReferences(results: CodeChunk[]): CodeChunk[] {
    const MAX_EXPANDED = 4;
    const top = results[0];
    if (!top) return results;

    const alreadyIncluded = new Set(results.map((r) => r.id));
    const expanded: CodeChunk[] = [];

    const addChunk = (chunk: CodeChunk | undefined) => {
      if (!chunk || expanded.length >= MAX_EXPANDED || alreadyIncluded.has(chunk.id)) return;
      expanded.push(chunk);
      alreadyIncluded.add(chunk.id);
    };

    for (const refId of top.references ?? []) addChunk(this.chunks.get(refId));
    for (const ref of top.externalRefs ?? []) addChunk(this.resolveExternalRef(ref));

    return [...results, ...expanded];
  }

  private static readonly MAX_COLLAPSED_PER_FILE = 40;

  /**
   * Renders search results as a "ghost file" per source file rather than
   * floating, context-free chunks: the file's imports/top-level constants at
   * the top, the full code of the matched symbols in place, and every other
   * symbol in that file collapsed to a one-line signature with its line
   * range. This gives an AI the structural coordinates it needs to edit
   * safely — what's imported, what else lives in the file, and exact line
   * numbers — without shipping whole files.
   */
  buildContext(results: CodeChunk[]): string {
    if (results.length === 0) return '';

    const relevantByFile = new Map<string, Set<string>>();
    const fileOrder: string[] = [];
    for (const r of results) {
      if (!relevantByFile.has(r.filePath)) {
        relevantByFile.set(r.filePath, new Set());
        fileOrder.push(r.filePath);
      }
      relevantByFile.get(r.filePath)!.add(r.id);
    }

    const blocks: string[] = [];
    for (const filePath of fileOrder) {
      const relevant = relevantByFile.get(filePath)!;
      const record = this.files.get(filePath);
      const fileChunks = (record?.chunkIds ?? [...relevant])
        .map((id) => this.chunks.get(id))
        .filter((c): c is CodeChunk => c !== undefined)
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

      const out: string[] = [`// ═══ ${filePath} ═══`];
      const header = fileChunks.find((c) => c.kind === 'module');
      if (header) out.push(header.code);

      let collapsedShown = 0;
      let collapsedTotal = 0;
      for (const chunk of fileChunks) {
        if (chunk.kind === 'module') continue;
        if (chunk.symbolName === '__file__') {
          if (relevant.has(chunk.id)) out.push(chunk.code);
          continue;
        }
        if (relevant.has(chunk.id)) {
          out.push(`// ▸ ${chunk.symbolName}  (${chunk.kind}, lines ${chunk.startLine}-${chunk.endLine})`);
          out.push(chunk.code);
        } else {
          collapsedTotal++;
          if (collapsedShown >= IndexStore.MAX_COLLAPSED_PER_FILE) continue;
          const signature = chunk.code.split('\n')[0].trim();
          out.push(`//   ${chunk.symbolName}  (${chunk.kind}, lines ${chunk.startLine}-${chunk.endLine}):  ${signature}`);
          collapsedShown++;
        }
      }
      if (collapsedTotal > collapsedShown) {
        out.push(`//   … ${collapsedTotal - collapsedShown} more symbol(s) in this file`);
      }
      blocks.push(out.join('\n'));
    }
    return blocks.join('\n\n');
  }

  stats() {
    return {
      files: this.files.size,
      chunks: this.chunks.size,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Records the token cost of one search_context call vs the naive
   * baseline of reading the whole file for every file the results came
   * from (i.e. what an AI tool would've paid without targeted search).
   */
  trackSearch(query: string, results: CodeChunk[], targetedText?: string): SearchLogEntry {
    const touchedFiles = new Set(results.map((r) => r.filePath));
    const naiveTokens = [...touchedFiles].reduce((sum, filePath) => {
      const content = this.files.get(filePath)?.content ?? '';
      return sum + estimateTokens(content);
    }, 0);
    // Measure the actual rendered output when provided (the ghost-file view),
    // so the reported savings reflect what was really sent, not just raw chunks.
    const targetedTokens = estimateTokens(targetedText ?? results.map((r) => r.code).join('\n\n'));

    const entry: SearchLogEntry = {
      query,
      timestamp: new Date().toISOString(),
      naiveTokens,
      targetedTokens,
      savedTokens: Math.max(0, naiveTokens - targetedTokens),
      chunkCount: results.length,
    };

    this.searchLog.push(entry);
    if (this.searchLog.length > SEARCH_LOG_LIMIT) this.searchLog.shift();
    this.totalNaiveTokens += naiveTokens;
    this.totalTargetedTokens += targetedTokens;

    return entry;
  }

  tokenSavings() {
    const totalSaved = Math.max(0, this.totalNaiveTokens - this.totalTargetedTokens);
    const reductionPct =
      this.totalNaiveTokens === 0 ? 0 : Math.round((totalSaved / this.totalNaiveTokens) * 100);
    return {
      calls: this.searchLog.length,
      totalNaiveTokens: this.totalNaiveTokens,
      totalTargetedTokens: this.totalTargetedTokens,
      totalSavedTokens: totalSaved,
      reductionPct,
      recent: this.searchLog.slice(-10),
    };
  }

  /** Writes the whole index to disk as JSON, without blocking the event loop. */
  async save(snapshotPath: string): Promise<void> {
    const snapshot: IndexSnapshot = {
      version: 1,
      embeddingModel: EMBEDDING_MODEL,
      files: [...this.files.values()],
      chunks: [...this.chunks.values()],
    };
    await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.promises.writeFile(snapshotPath, JSON.stringify(snapshot), 'utf-8');
  }

  /**
   * Loads a previously saved snapshot, if present. Returns false if there
   * was nothing to load, OR if the snapshot was embedded with a different
   * model than the one currently in use — mixing vectors from two models
   * would make cosine similarity meaningless without ever erroring, so a
   * mismatch is treated the same as "no snapshot" and triggers a fresh
   * re-index instead of silently corrupting search quality.
   */
  load(snapshotPath: string): boolean {
    if (!fs.existsSync(snapshotPath)) return false;
    try {
      const snapshot: IndexSnapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
      if (snapshot.version !== 1) return false;
      if (snapshot.embeddingModel !== EMBEDDING_MODEL) return false;
      this.files.clear();
      this.chunks.clear();
      for (const file of snapshot.files) this.files.set(file.filePath, file);
      for (const chunk of snapshot.chunks) this.chunks.set(chunk.id, chunk);
      return true;
    } catch {
      return false; // corrupt/unreadable snapshot, fall back to a fresh index
    }
  }
}
