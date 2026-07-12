/** Rough ~4-chars-per-token heuristic, consistent with demo/benchmark.ts. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
