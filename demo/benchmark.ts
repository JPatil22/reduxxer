import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexStore } from '../src/store.js';
import { indexRepo } from '../src/watcher.js';
import { estimateTokens } from '../src/tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is dist/demo at runtime; fixture .ts sources live under the
// project's demo/fixture-repo (tsc only emits .js into dist), so walk up
// to the project root and back down to the source fixture dir.
const fixtureRepo = path.join(__dirname, '..', '..', 'demo', 'fixture-repo');

function naiveDump(rootDir: string): string {
  const files = fs.readdirSync(rootDir).filter((f) => f.endsWith('.ts'));
  return files.map((f) => fs.readFileSync(path.join(rootDir, f), 'utf-8')).join('\n\n');
}

async function main() {
  const query = process.argv[2] ?? 'send an email when an order ships';

  const naiveText = naiveDump(fixtureRepo);
  const naiveTokens = estimateTokens(naiveText);

  const store = new IndexStore();
  await indexRepo(store, fixtureRepo);
  const results = await store.search(query, 3);
  const smartText = results.map((r) => r.code).join('\n\n');
  const smartTokens = estimateTokens(smartText);

  const fileCount = fs.readdirSync(fixtureRepo).filter((f) => f.endsWith('.ts')).length;

  console.log(`Query: "${query}"\n`);
  console.log(
    `Naive (dump whole fixture repo):   ~${naiveTokens} tokens (${naiveText.length} chars, ${fileCount} files)`
  );
  console.log(
    `Targeted (search_context, top 3):  ~${smartTokens} tokens (${smartText.length} chars, ${results.length} chunks: ${results
      .map((r) => r.symbolName)
      .join(', ')})`
  );

  const reduction = naiveTokens === 0 ? 0 : Math.round((1 - smartTokens / naiveTokens) * 100);
  console.log(`\nEstimated reduction: ${reduction}%`);
  console.log(
    `\nNote: this fixture repo is intentionally tiny (3 files) just to prove the mechanism.\nPoint "npm run index -- /path/to/a/real/repo" at an actual project to see much bigger savings\n(real repos are hundreds/thousands of files, so naive dumps get huge while targeted search stays small).`
  );
}

main();
