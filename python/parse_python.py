"""
Reads Python source from stdin, parses it with the standard library `ast`
module (real parsing, not regex/text matching), and prints JSON describing
each top-level function/class: name, kind, and 1-indexed line range.

Invoked as a subprocess from src/pythonIndexer.ts — one call per file.
"""
import ast
import json
import sys


def main() -> None:
    source = sys.stdin.read()
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        print(json.dumps({"error": str(e)}))
        return

    chunks = []
    for node in tree.body:
        if isinstance(node, ast.AsyncFunctionDef):
            kind = "async-function"
        elif isinstance(node, ast.FunctionDef):
            kind = "function"
        elif isinstance(node, ast.ClassDef):
            kind = "class"
        else:
            continue
        chunks.append(
            {
                "name": node.name,
                "kind": kind,
                "start": node.lineno,
                "end": node.end_lineno,
            }
        )

    print(json.dumps({"chunks": chunks}))


if __name__ == "__main__":
    main()
