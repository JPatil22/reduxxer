import fs from 'node:fs';
import path from 'node:path';
import { CodeChunk, FileRecord, SearchLogEntry } from './types.js';
import { estimateTokens } from './tokens.js';
import { embedText, cosineSimilarity, EMBEDDING_MODEL } from './embeddings.js';
import { memoizingStemmer as stemmer } from 'porter-stemmer';
import { AnnIndex } from './annIndex.js';

// Explicit escape hatch: brute-force cosine search (IndexStore's default,
// always-available path) stays fully intact regardless of this setting —
// disabling ANN just means IndexStore never switches to it, even for a
// huge repo. Set false via --no-ann if the ANN path is ever suspected of
// causing a problem, without needing a code change to fall back.
let annEnabled = true;
export function setAnnEnabled(enabled: boolean): void {
  annEnabled = enabled;
}

// On disk, a chunk's embedding is a base64 Float32 string (`emb`) rather than
// a JSON array of ~384 full-precision numbers — roughly 3x smaller on disk.
type SerializedChunk = Omit<CodeChunk, 'embedding'> & { emb?: string };

interface IndexSnapshot {
  version: 1;
  embeddingModel: string;
  lastUpdatedAt?: string;
  files: FileRecord[];
  chunks: SerializedChunk[];
  // Token-savings tracking, persisted so the counter reflects the tool's
  // whole lifetime on this repo instead of resetting to zero on restart.
  searchLog?: SearchLogEntry[];
  totalNaiveTokens?: number;
  totalTargetedTokens?: number;
}

const SEARCH_LOG_LIMIT = 200;

function encodeEmbedding(vec: number[]): string {
  return Buffer.from(Float32Array.from(vec).buffer).toString('base64');
}

function decodeEmbedding(b64: string): number[] {
  const buf = Buffer.from(b64, 'base64');
  // Account for byteOffset — Node Buffers can be views into a shared pool.
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
}

function serializeChunk(chunk: CodeChunk): SerializedChunk {
  const { embedding, ...rest } = chunk;
  return embedding ? { ...rest, emb: encodeEmbedding(embedding) } : rest;
}

function deserializeChunk(chunk: SerializedChunk): CodeChunk {
  const { emb, ...rest } = chunk;
  return emb ? { ...rest, embedding: decodeEmbedding(emb) } : rest;
}

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
  // Actual time the index last changed — not "now" on every stats() call.
  private lastUpdatedAt = new Date().toISOString();

  // BM25 corpus statistics, rebuilt lazily when the index changes. Per-chunk
  // term frequencies + lengths, per-term document frequency, and the average
  // document length — everything BM25 needs to weight rare terms higher and
  // saturate repeated ones, instead of the old raw keyword count.
  private bm25Docs = new Map<string, { tf: Map<string, number>; len: number }>();
  private bm25Df = new Map<string, number>();
  private bm25Avgdl = 1;
  private bm25Dirty = true;

  // Approximate nearest-neighbor index (usearch/HNSW), built only once the
  // corpus of embedded chunks crosses this threshold. Below it, brute-force
  // cosine search (this class's default, always-available path) is already
  // fast — verified 175ms at 50k chunks — and simpler to trust than a native
  // dependency, so there's no reason to pay ANN's one-time build cost for a
  // repo that doesn't need it. Mutable (not readonly) so tests can lower it
  // instead of constructing tens of thousands of chunks to exercise this path.
  private static ANN_THRESHOLD = 20000;
  static setAnnThresholdForTests(n: number): void {
    IndexStore.ANN_THRESHOLD = n;
  }
  private annIndex: AnnIndex | null = null;

  getFileHash(filePath: string): string | undefined {
    return this.files.get(filePath)?.hash;
  }

  /** All file paths currently in the index. Used by the reconcile sweep to
   *  detect files that were deleted while a watch event was missed. */
  indexedFilePaths(): string[] {
    return [...this.files.keys()];
  }

  upsertFile(filePath: string, hash: string, chunks: CodeChunk[], content: string): void {
    const old = this.files.get(filePath);
    if (old) {
      for (const id of old.chunkIds) {
        this.chunks.delete(id);
        this.annIndex?.remove(id);
      }
    }
    const chunkIds: string[] = [];
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
      chunkIds.push(chunk.id);
      if (this.annIndex && chunk.embedding) this.annIndex.add(chunk.id, chunk.embedding);
    }
    this.files.set(filePath, { filePath, hash, chunkIds, tokens: estimateTokens(content) });
    this.lastUpdatedAt = new Date().toISOString();
    this.bm25Dirty = true;
    this.maybeInitAnn();
  }

  removeFile(filePath: string): void {
    const old = this.files.get(filePath);
    if (old) {
      for (const id of old.chunkIds) {
        this.chunks.delete(id);
        this.annIndex?.remove(id);
      }
      this.files.delete(filePath);
      this.lastUpdatedAt = new Date().toISOString();
      this.bm25Dirty = true;
    }
  }

  /**
   * The first time the embedded-chunk count crosses ANN_THRESHOLD, builds
   * the index once from everything currently indexed (logged, since this is
   * a real one-time delay, not something to leave silent). After that,
   * upsertFile/removeFile above keep it incrementally in sync — no more
   * full rebuilds on every file change, which would otherwise make normal
   * editing feel like it hangs. If building fails for any reason, falls
   * back to brute-force (annIndex stays null) rather than crash the daemon.
   */
  private maybeInitAnn(): void {
    if (!annEnabled || this.annIndex) return;
    const embedded = [...this.chunks.values()].filter((c) => c.embedding);
    if (embedded.length < IndexStore.ANN_THRESHOLD) return;
    try {
      const dim = embedded[0].embedding!.length;
      const idx = new AnnIndex(dim);
      console.error(
        `context-daemon: ${embedded.length} embedded chunks crossed the fast-search threshold (${IndexStore.ANN_THRESHOLD}) — building a fast search index now, this is a one-time cost and may take a while on a large repo...`
      );
      const t0 = Date.now();
      for (const c of embedded) idx.add(c.id, c.embedding!);
      console.error(`context-daemon: fast search index built in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
      this.annIndex = idx;
    } catch (err) {
      console.error('context-daemon: failed to build fast search index, falling back to standard search:', err);
      this.annIndex = null;
    }
  }

  allChunks(): CodeChunk[] {
    return [...this.chunks.values()];
  }

  /** Content words from a query, stemmed — drops short tokens and common
   *  filler so a single letter like "a" in "render a chart" can't match
   *  every chunk, and reduces words to a root form ("running" -> "run") so
   *  the relevance gate recognizes the same matches BM25 scores on. */
  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length >= 2 && !IndexStore.STOPWORDS.has(t))
      .map((t) => stemmer(t));
  }

  // BM25 tuning: k1 controls term-frequency saturation, b controls how much
  // long documents are penalized. These are the standard defaults.
  private static readonly BM25_K1 = 1.5;
  private static readonly BM25_B = 0.75;

  /** Tokenizes code/text for BM25: splits on non-alphanumerics and camelCase
   *  boundaries so `getUserById` contributes get/user/by/id, lowercased, then
   *  stemmed to a root form (Porter stemmer) so "running"/"runs" and a
   *  function named "run" or "run_process" share a token instead of missing
   *  each other on exact spelling. No stopword filtering — BM25's IDF
   *  down-weights common words on its own. */
  private tokenize(text: string): string[] {
    return text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2)
      .map((t) => stemmer(t));
  }

  /** Rebuilds BM25 corpus statistics from the current chunks. Lazy: only
   *  runs when the index has changed since the last search. */
  private rebuildBm25(): void {
    this.bm25Docs.clear();
    this.bm25Df.clear();
    let totalLen = 0;
    for (const chunk of this.chunks.values()) {
      const tokens = this.tokenize(`${chunk.symbolName} ${chunk.code}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.bm25Docs.set(chunk.id, { tf, len: tokens.length });
      totalLen += tokens.length;
      for (const term of tf.keys()) this.bm25Df.set(term, (this.bm25Df.get(term) ?? 0) + 1);
    }
    this.bm25Avgdl = this.bm25Docs.size > 0 ? totalLen / this.bm25Docs.size : 1;
    this.bm25Dirty = false;
  }

  /** BM25 relevance score of one chunk for the given query tokens. Rare query
   *  terms (low document frequency) count for more; repeated terms saturate;
   *  long documents are length-normalized. Returns 0 for no term overlap. */
  private bm25Score(queryTokens: string[], chunkId: string): number {
    const doc = this.bm25Docs.get(chunkId);
    if (!doc) return 0;
    const n = this.bm25Docs.size;
    const { BM25_K1: k1, BM25_B: b } = IndexStore;
    let score = 0;
    for (const term of queryTokens) {
      const f = doc.tf.get(term);
      if (!f) continue;
      const df = this.bm25Df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.len) / this.bm25Avgdl)));
    }
    return score;
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
    if (this.bm25Dirty) this.rebuildBm25();
    const chunks = this.allChunks();
    const hasEmbeddings = chunks.some((c) => c.embedding);
    const queryEmbedding = hasEmbeddings ? await embedText(query) : null;
    return this.searchWithEmbedding(query, queryEmbedding, limit, chunks);
  }

  /**
   * Test-only: searches using a pre-computed embedding directly instead of
   * running the real (slow, non-deterministic-to-set-up) embedding model —
   * lets ANN correctness tests use small, synthetic, deterministic vectors
   * to verify actual ranking behavior, not just "it doesn't crash".
   */
  async searchByEmbeddingForTests(embedding: number[], limit = 5): Promise<CodeChunk[]> {
    if (this.bm25Dirty) this.rebuildBm25();
    return this.searchWithEmbedding('', embedding, limit, this.allChunks());
  }

  private async searchWithEmbedding(
    query: string,
    queryEmbedding: number[] | null,
    limit: number,
    chunks: CodeChunk[]
  ): Promise<CodeChunk[]> {
    const normalizedQuery = query.toLowerCase().trim();
    const terms = this.queryTerms(query);
    const queryTokens = this.tokenize(query);

    // When the ANN index is active, pull a generous candidate set of
    // semantically-close chunks from it instead of computing cosine
    // similarity against every single chunk. Chunks outside this candidate
    // set simply get semantic=0 (same as a chunk with no embedding at all)
    // — they still fully qualify for results via an exact name match or
    // real lexical (BM25) overlap, just without the semantic-floor boost.
    // Requesting well more than `limit` candidates leaves room for BM25 and
    // the relevance gate below to re-rank without losing the true best match.
    let annScores: Map<string, number> | null = null;
    if (this.annIndex && queryEmbedding) {
      const candidateK = Math.max(limit * 10, 50);
      annScores = new Map(this.annIndex.search(queryEmbedding, candidateK).map((r) => [r.chunkId, r.similarity]));
    }

    // BM25 scores are unbounded and corpus-dependent, so normalize them to
    // [0,1] within this query (top lexical hit = 1) before blending with the
    // semantic score, which is already [0,1]. Reduced with a loop rather than
    // Math.max(0, ...bm25Raw) — spreading a large array as call arguments
    // hits V8's argument-count limit and crashes on big repos (verified: a
    // 200,000-chunk corpus threw "Maximum call stack size exceeded" here).
    const bm25Raw = chunks.map((c) => this.bm25Score(queryTokens, c.id));
    let bm25Max = 0;
    for (const s of bm25Raw) if (s > bm25Max) bm25Max = s;

    const scored = chunks.map((chunk, i) => {
      // Normalized BM25, with a penalty for whole-file fallback chunks — a
      // giant file stuffed with repeated terms shouldn't outrank the real
      // function that answers, which BM25 length-normalization alone doesn't
      // fully prevent.
      const kindPenalty = chunk.kind === 'file' ? 0.3 : 1;
      const lexical = (bm25Max > 0 ? bm25Raw[i] / bm25Max : 0) * kindPenalty;
      const semantic = annScores
        ? (annScores.get(chunk.id) ?? 0)
        : queryEmbedding && chunk.embedding
          ? cosineSimilarity(queryEmbedding, chunk.embedding)
          : 0;
      // Semantic similarity (0-1) drives ranking; normalized BM25 (0-1) is a
      // smaller additive boost so exact identifier/keyword matches still surface.
      const score = semantic + lexical * 0.2;

      // Relevance gate — a chunk counts as a real match if ANY of:
      //  - the whole query is a substring of the symbol name (exact lookup);
      //  - it clears the semantic floor (strong meaning match);
      //  - it contains at least two distinct query content-words (real
      //    lexical overlap concentrated in one chunk, which rescues genuine
      //    matches that score low semantically in tiny repos).
      // A query for functionality that doesn't exist shares at most one
      // incidental word and has low similarity, so it clears none of these
      // and returns nothing instead of the nearest wrong chunk. Checked
      // against the same stemmed token set BM25 scores on (exact token
      // membership, not a raw substring scan — avoids false positives like
      // "art" matching inside "start").
      const doc = this.bm25Docs.get(chunk.id);
      const distinctTerms = doc ? terms.filter((t) => doc.tf.has(t)).length : 0;
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
  // spurious hits (a query is natural language, not just identifiers). Kept
  // to genuine filler so short identifiers like id/db/ui/fs still count.
  private static readonly STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'was', 'this', 'that', 'with', 'from', 'what', 'where', 'when',
    'why', 'how', 'does', 'did', 'has', 'have', 'its', 'you', 'your', 'into', 'not', 'but', 'can',
    'will', 'all', 'any', 'out', 'get', 'got', 'let', 'via', 'per', 'off',
    'is', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'if', 'we', 'do', 'an', 'as', 'be', 'it', 'so',
    'no', 'up', 'my', 'me',
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

  /** Appends the top result's dependencies — both same-file (`references`)
   *  and imported-from-another-file (`externalRefs`) — chasing up to
   *  MAX_HOPS deep (A -> B -> C, not just A -> B), if not already present,
   *  capped so expansion can't dwarf the real matches. This is what lets the
   *  daemon hand over an imported function alongside the function that uses
   *  it, instead of leaving the caller to go read the other file itself.
   *  Cycles (A -> B -> A) are safe: a chunk already added is never
   *  re-enqueued, so the frontier shrinks to nothing rather than looping. */
  private expandWithReferences(results: CodeChunk[]): CodeChunk[] {
    const MAX_EXPANDED = 4;
    const MAX_HOPS = 2;
    const top = results[0];
    if (!top) return results;

    const alreadyIncluded = new Set(results.map((r) => r.id));
    const expanded: CodeChunk[] = [];

    const addChunk = (chunk: CodeChunk | undefined): CodeChunk | undefined => {
      if (!chunk || expanded.length >= MAX_EXPANDED || alreadyIncluded.has(chunk.id)) return undefined;
      expanded.push(chunk);
      alreadyIncluded.add(chunk.id);
      return chunk;
    };

    let frontier = [top];
    for (let hop = 0; hop < MAX_HOPS && expanded.length < MAX_EXPANDED && frontier.length > 0; hop++) {
      const nextFrontier: CodeChunk[] = [];
      for (const chunk of frontier) {
        for (const refId of chunk.references ?? []) {
          const added = addChunk(this.chunks.get(refId));
          if (added) nextFrontier.push(added);
        }
        for (const ref of chunk.externalRefs ?? []) {
          const added = addChunk(this.resolveExternalRef(ref));
          if (added) nextFrontier.push(added);
        }
        if (expanded.length >= MAX_EXPANDED) break;
      }
      frontier = nextFrontier;
    }

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
      lastUpdated: this.lastUpdatedAt,
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
      return sum + (this.files.get(filePath)?.tokens ?? 0);
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

  /**
   * Writes the whole index to disk as JSON, without blocking the event loop.
   * Atomic: writes to a temp file and renames it over the target, so a crash
   * or Ctrl+C mid-write can't leave a half-written (corrupt) snapshot that
   * would make the next startup silently discard the whole index.
   */
  async save(snapshotPath: string): Promise<void> {
    const snapshot: IndexSnapshot = {
      version: 1,
      embeddingModel: EMBEDDING_MODEL,
      lastUpdatedAt: this.lastUpdatedAt,
      files: [...this.files.values()],
      chunks: [...this.chunks.values()].map(serializeChunk),
      searchLog: this.searchLog,
      totalNaiveTokens: this.totalNaiveTokens,
      totalTargetedTokens: this.totalTargetedTokens,
    };
    await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
    const tmpPath = `${snapshotPath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(snapshot), 'utf-8');
    await fs.promises.rename(tmpPath, snapshotPath); // atomic on the same filesystem

    // Persist the ANN index too, if built — so a restart doesn't pay the
    // one-time build cost again. Not fatal if this fails; load() falls back
    // to rebuilding fresh (via maybeInitAnn) the same as if it were missing.
    if (this.annIndex) {
      try {
        this.annIndex.save(IndexStore.annPath(snapshotPath));
      } catch (err) {
        console.error('context-daemon: failed to save fast search index (will rebuild next start):', err);
      }
    }
  }

  private static annPath(snapshotPath: string): string {
    return `${snapshotPath}.ann`;
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
      this.annIndex = null;
      for (const file of snapshot.files) this.files.set(file.filePath, file);
      for (const chunk of snapshot.chunks) {
        const c = deserializeChunk(chunk);
        this.chunks.set(c.id, c);
      }
      if (snapshot.lastUpdatedAt) this.lastUpdatedAt = snapshot.lastUpdatedAt;
      // Restore cumulative token-savings tracking so the counter reflects
      // this repo's whole history with the tool, not just the current
      // process's uptime. Missing on an older snapshot (pre-this-feature)
      // simply means starting the counters fresh, same as today's default.
      this.searchLog = snapshot.searchLog ?? [];
      this.totalNaiveTokens = snapshot.totalNaiveTokens ?? 0;
      this.totalTargetedTokens = snapshot.totalTargetedTokens ?? 0;

      // Try to restore a persisted ANN index instead of paying the full
      // build cost again on every restart. If it's missing, stale (chunk
      // count doesn't match — repo changed since last save), or corrupt,
      // leave annIndex null; maybeInitAnn() rebuilds it fresh the next time
      // a file is indexed (also called here directly, so a restart with no
      // file changes at all still ends up with ANN active, not stuck on
      // brute-force until something happens to change).
      if (annEnabled) {
        const embedded = [...this.chunks.values()].filter((c) => c.embedding);
        if (embedded.length >= IndexStore.ANN_THRESHOLD) {
          const dim = embedded[0].embedding!.length;
          const idx = new AnnIndex(dim);
          if (idx.load(IndexStore.annPath(snapshotPath)) && idx.size === embedded.length) {
            this.annIndex = idx;
          } else {
            this.maybeInitAnn();
          }
        }
      }
      return true;
    } catch {
      return false; // corrupt/unreadable snapshot, fall back to a fresh index
    }
  }
}
