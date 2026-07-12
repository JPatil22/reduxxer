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
