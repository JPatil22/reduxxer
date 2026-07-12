import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

/** Bump this if the model ever changes — store.ts stamps it into every
 *  snapshot so a mismatched snapshot (embedded with a different model) is
 *  never silently mixed with fresh vectors from this one. */
export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    // Downloads and caches the model on first call (~90MB, one time).
    embedderPromise = pipeline('feature-extraction', EMBEDDING_MODEL) as Promise<FeatureExtractionPipeline>;
  }
  return embedderPromise;
}

/** Embeds text into a normalized vector. Truncate long inputs by the caller
 *  to keep inference fast — this model has a 256-token context window anyway. */
export async function embedText(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
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
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const text of texts) {
    vectors.push(await embedText(text));
  }
  return vectors;
}

/** Dot product of two normalized vectors == cosine similarity. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
