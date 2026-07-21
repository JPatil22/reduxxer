import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

/** Bump this if the model ever changes — store.ts stamps it into every
 *  snapshot so a mismatched snapshot (embedded with a different model) is
 *  never silently mixed with fresh vectors from this one. */
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

// Retrieval prefix seam (kept for a future model swap). MiniLM is symmetric —
// no prefix either side. BGE-style models would set a query-side instruction
// here; note that swapping models also requires recalibrating SEMANTIC_FLOOR in
// store.ts (bge's similarity distribution broke the negative-control gate).
const QUERY_PREFIX = '';
const DOC_PREFIX = '';

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;
let embeddingsEnabled = true;

/** Turns off embeddings entirely (lexical-only mode) — no model download,
 *  no inference. Search still works via the lexical relevance gate. */
export function disableEmbeddings(): void {
  embeddingsEnabled = false;
}

export function setEmbeddingsEnabled(enabled: boolean): void {
  embeddingsEnabled = enabled;
}

export function embeddingsAreEnabled(): boolean {
  return embeddingsEnabled;
}

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    // The model is downloaded and cached on first use (~90MB). Announce it
    // so the first run isn't a silent multi-minute hang.
    console.error(
      `context-daemon: loading local embedding model (${EMBEDDING_MODEL}); first run downloads ~90MB, cached afterwards...`
    );
    embedderPromise = (pipeline('feature-extraction', EMBEDDING_MODEL) as Promise<FeatureExtractionPipeline>).then(
      (p) => {
        console.error('context-daemon: embedding model ready.');
        return p;
      }
    );
  }
  return embedderPromise;
}

// Serialize inference. There is ONE shared ONNX pipeline, and its session is
// not safe to call concurrently — yet concurrent searches (especially via the
// HTTP multi-client transport) plus background indexing would otherwise invoke
// it at the same time. A promise chain runs each inference only after the
// previous one settles. Serializing costs nothing real here: this model's ONNX
// runtime is single-threaded CPU, so concurrent calls would contend anyway.
let inferenceLock: Promise<unknown> = Promise.resolve();

function withInferenceLock<T>(task: () => Promise<T>): Promise<T> {
  const run = inferenceLock.then(task, task);
  // Keep the chain alive after this task settles, swallowing its result/error
  // so one failed inference can't wedge every subsequent call.
  inferenceLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Test-only: exercise the inference serialization primitive directly, so a
 *  test can prove calls don't overlap without loading the real model. */
export function withInferenceLockForTests<T>(task: () => Promise<T>): Promise<T> {
  return withInferenceLock(task);
}

/** Embeds text into a normalized vector. `kind` selects the retrieval prefix:
 *  'query' for a search query, 'document' for an indexed code chunk — they must
 *  match so the query and the chunks land in the same space. Callers truncate
 *  long inputs to keep inference fast. */
export async function embedText(text: string, kind: 'query' | 'document' = 'query'): Promise<number[]> {
  if (!embeddingsEnabled) return [];
  const embedder = await getEmbedder();
  const input = (kind === 'query' ? QUERY_PREFIX : DOC_PREFIX) + text;
  return withInferenceLock(async () => {
    const output = await embedder(input, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  });
}

/**
 * Embeds many texts, one at a time. Tried true batched model calls here
 * (passing an array to the pipeline in one shot) expecting the usual
 * "amortize overhead across a batch" win — measured it on a real file
 * with 100+ functions and it was consistently slower than sequential
 * (padding every short chunk up to the longest one in the batch wastes
 * more compute on this CPU/ONNX runtime than it saves), and an oversized
 * batch could even exceed the allocator's memory. So this stays
 * sequential; kept as its own function so call sites don't need to know
 * that, and so a future GPU/native runtime swap has one place to change.
 */
export async function embedTexts(texts: string[], kind: 'query' | 'document' = 'document'): Promise<number[][]> {
  if (!embeddingsEnabled) return [];
  const vectors: number[][] = [];
  for (const text of texts) {
    vectors.push(await embedText(text, kind));
  }
  return vectors;
}

/** Dot product of two normalized vectors == cosine similarity. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
