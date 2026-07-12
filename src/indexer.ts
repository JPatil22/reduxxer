import ts from 'typescript';
import crypto from 'node:crypto';
import { CodeChunk } from './types.js';

function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * Parses one file into symbol-level chunks (functions, classes,
 * interfaces, const arrow-functions) using the TypeScript compiler API.
 * No native bindings required, works for both .js and .ts/.tsx files.
 */
export function parseFile(filePath: string, content: string): CodeChunk[] {
  const fileHash = hashContent(content);
  const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const chunks: CodeChunk[] = [];
  const lines = content.split('\n');

  function getLineRange(node: ts.Node): { start: number; end: number } {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return { start, end };
  }

  function addChunk(name: string, kind: string, node: ts.Node) {
    const { start, end } = getLineRange(node);
    const code = lines.slice(start - 1, end).join('\n');
    chunks.push({
      id: `${filePath}::${name}`,
      filePath,
      symbolName: name,
      kind,
      startLine: start,
      endLine: end,
      code,
      fileHash,
    });
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addChunk(node.name.text, 'function', node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addChunk(node.name.text, 'class', node);
    } else if (ts.isInterfaceDeclaration(node)) {
      addChunk(node.name.text, 'interface', node);
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          addChunk(decl.name.text, 'const-function', node);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({
      id: `${filePath}::__file__`,
      filePath,
      symbolName: '__file__',
      kind: 'file',
      startLine: 1,
      endLine: lines.length,
      code: content,
      fileHash,
    });
  }

  return chunks;
}
