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

  /** Lexical relevance score: keyword hits normalized by chunk size, with a
   *  bonus for symbol-name matches and a penalty for whole-file fallback
   *  chunks. Returns 0 for no match. */
  private lexicalScore(query: string, chunk: CodeChunk): number {
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    const haystack = (chunk.symbolName + ' ' + chunk.code).toLowerCase();
    let rawScore = 0;
    for (const term of terms) {
      if (!term) continue;
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

    const scored = chunks.map((chunk) => {
      const lexical = this.lexicalScore(query, chunk);
      const semantic =
        queryEmbedding && chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0;
      // Semantic similarity (0-1) drives ranking; lexical score is a smaller
      // additive boost so exact identifier/keyword matches still float up.
      const score = semantic + lexical * 0.05;
      return { chunk, score, matched: semantic > 0 || lexical > 0 };
    });

    const results = scored
      .filter((s) => s.matched)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.chunk);

    return this.expandWithReferences(results);
  }

  /** Appends the top result's direct same-file dependencies (if not
   *  already present), capped so expansion can't dwarf the real matches. */
  private expandWithReferences(results: CodeChunk[]): CodeChunk[] {
    const MAX_EXPANDED = 3;
    const top = results[0];
    if (!top?.references?.length) return results;

    const alreadyIncluded = new Set(results.map((r) => r.id));
    const expanded: CodeChunk[] = [];
    for (const refId of top.references) {
      if (expanded.length >= MAX_EXPANDED) break;
      if (alreadyIncluded.has(refId)) continue;
      const refChunk = this.chunks.get(refId);
      if (refChunk) {
        expanded.push(refChunk);
        alreadyIncluded.add(refId);
      }
    }
    return [...results, ...expanded];
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
  trackSearch(query: string, results: CodeChunk[]): SearchLogEntry {
    const touchedFiles = new Set(results.map((r) => r.filePath));
    const naiveTokens = [...touchedFiles].reduce((sum, filePath) => {
      const content = this.files.get(filePath)?.content ?? '';
      return sum + estimateTokens(content);
    }, 0);
    const targetedTokens = estimateTokens(results.map((r) => r.code).join('\n\n'));

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
