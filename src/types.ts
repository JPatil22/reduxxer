export interface CodeChunk {
  id: string;          // `${filePath}::${symbolName}`
  filePath: string;
  symbolName: string;
  kind: string;         // 'function' | 'class' | 'interface' | 'const-function' | 'file'
  startLine: number;
  endLine: number;
  code: string;
  fileHash: string;
  /** Normalized embedding vector for semantic search, if computed. */
  embedding?: number[];
  /** Chunk ids of other same-file symbols this chunk calls, e.g.
   *  processPayment calling validateCard records validateCard's chunk id.
   *  Used to expand a search result with its direct dependencies instead
   *  of returning it in isolation. */
  references?: string[];
  /** Cross-file dependencies: symbols this chunk calls that are imported
   *  from another file, stored as "<resolved-path-without-extension>::<name>"
   *  because the exact file extension isn't known at parse time. The store
   *  resolves these against the full index at search time (trying .ts/.tsx/
   *  .js/... and /index) so an imported function gets pulled in too. */
  externalRefs?: string[];
}

export interface FileRecord {
  filePath: string;
  hash: string;
  chunkIds: string[];
  /** Full file text at index time, kept so we can estimate the naive
   *  "would've read the whole file" token cost for savings tracking. */
  content: string;
}

export interface SearchLogEntry {
  query: string;
  timestamp: string;
  naiveTokens: number;
  targetedTokens: number;
  savedTokens: number;
  chunkCount: number;
}
