import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    // Downloads and caches the model on first call (~90MB, one time).
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') as Promise<FeatureExtractionPipeline>;
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

/** Dot product of two normalized vectors == cosine similarity. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
