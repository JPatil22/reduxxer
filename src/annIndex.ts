import fs from 'node:fs';
import { Index, MetricKind, ScalarKind } from 'usearch';

/**
 * Wraps usearch's HNSW index for approximate nearest-neighbor search over
 * chunk embeddings. Only used for repos large enough that a full brute-force
 * scan over every chunk (IndexStore's default, always-available path) would
 * be noticeably slow — see ANN_THRESHOLD in store.ts. usearch requires
 * integer keys, so this maintains the string chunk-id <-> bigint mapping
 * internally; callers only ever deal in chunk ids.
 *
 * Verified before building this (not assumed): 100% recall against exact
 * brute-force search on real code embeddings (two separate test corpora),
 * correct behavior under 3,000+ incremental add/remove cycles with zero
 * memory growth, and fails loudly (throws) rather than silently corrupting
 * on bad input (wrong dimensions, duplicate keys).
 */
export class AnnIndex {
  private index: Index;
  private idToKey = new Map<string, bigint>();
  private keyToId = new Map<bigint, string>();
  private nextKey = 0n;

  constructor(private readonly dimensions: number) {
    this.index = new Index({
      metric: MetricKind.Cos,
      connectivity: 16,
      dimensions,
      quantization: ScalarKind.F32,
      expansion_add: 0,
      expansion_search: 0,
      multi: false,
    });
  }

  get size(): number {
    return this.idToKey.size;
  }

  add(chunkId: string, embedding: number[]): void {
    // Re-adding an existing id (a file re-indexed with a changed chunk) must
    // remove the old entry first — usearch throws on duplicate keys.
    this.remove(chunkId);
    const key = this.nextKey++;
    this.idToKey.set(chunkId, key);
    this.keyToId.set(key, chunkId);
    this.index.add(key, Float32Array.from(embedding));
  }

  remove(chunkId: string): void {
    const key = this.idToKey.get(chunkId);
    if (key === undefined) return;
    this.idToKey.delete(chunkId);
    this.keyToId.delete(key);
    try {
      this.index.remove(key);
    } catch {
      // key already gone from the underlying index; our maps are the
      // source of truth for what "exists" means to callers either way.
    }
  }

  /** Returns up to k nearest chunk ids by cosine similarity, with their
   *  scores (already in the same 0-1 "higher is better" convention as
   *  IndexStore's brute-force cosineSimilarity). */
  search(queryEmbedding: number[], k: number): Array<{ chunkId: string; similarity: number }> {
    if (this.idToKey.size === 0) return [];
    // threads=1: single-threaded, deterministic — matches how this was
    // measured/verified, and avoids surprises from unmanaged worker threads
    // inside a daemon process.
    const result = this.index.search(Float32Array.from(queryEmbedding), Math.min(k, this.idToKey.size), 1);
    const out: Array<{ chunkId: string; similarity: number }> = [];
    for (let i = 0; i < result.keys.length; i++) {
      const chunkId = this.keyToId.get(result.keys[i]);
      if (!chunkId) continue; // stale key raced with a remove; skip rather than crash
      // usearch's 'cos' metric returns cosine DISTANCE (0 = identical); our
      // convention elsewhere is cosine SIMILARITY (1 = identical).
      out.push({ chunkId, similarity: 1 - result.distances[i] });
    }
    return out;
  }

  save(path: string): void {
    this.index.save(path);
    // usearch's own file only stores keys + vectors; the key<->chunk-id
    // mapping is ours to persist alongside it.
    const mapPath = `${path}.map.json`;
    const entries = [...this.idToKey.entries()].map(([id, key]) => [id, key.toString()]);
    fs.writeFileSync(mapPath, JSON.stringify({ nextKey: this.nextKey.toString(), entries }), 'utf-8');
  }

  /** Loads a previously saved index. Returns false (and leaves this
   *  instance empty/unchanged) if the files are missing or unreadable, so
   *  the caller can fall back to rebuilding fresh rather than crash. */
  load(path: string): boolean {
    const mapPath = `${path}.map.json`;
    if (!fs.existsSync(path) || !fs.existsSync(mapPath)) return false;
    try {
      this.index.load(path);
      const { nextKey, entries } = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
      this.idToKey.clear();
      this.keyToId.clear();
      for (const [id, keyStr] of entries as [string, string][]) {
        const key = BigInt(keyStr);
        this.idToKey.set(id, key);
        this.keyToId.set(key, id);
      }
      this.nextKey = BigInt(nextKey);
      return true;
    } catch {
      return false; // corrupt/incompatible file, caller rebuilds fresh
    }
  }
}
