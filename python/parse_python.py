"""
Reads Python source from stdin, parses it with the standard library `ast`
module (real parsing, not regex/text matching), and prints JSON describing
each top-level function/class: name, kind, 1-indexed line range, and which
other top-level symbols in this same file it calls (for one-hop dependency
expansion in search — see IndexStore.search in src/store.ts).

Invoked as a subprocess from src/pythonIndexer.ts — one call per file.
"""
import ast
import json
import sys


def called_names(node: ast.AST) -> set:
    """Names used as call targets within a node, e.g. validate_card(x)."""
    names = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
            names.add(child.func.id)
    return names


def main() -> None:
    source = sys.stdin.read()
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        print(json.dumps({"error": str(e)}))
        return

    defs = []
    for node in tree.body:
        if isinstance(node, ast.AsyncFunctionDef):
            kind = "async-function"
        elif isinstance(node, ast.FunctionDef):
            kind = "function"
        elif isinstance(node, ast.ClassDef):
            kind = "class"
        else:
            continue
        defs.append((node, kind))

    top_level_names = {node.name for node, _ in defs}

    chunks = []
    for node, kind in defs:
        references = sorted(called_names(node) & top_level_names - {node.name})
        chunks.append(
            {
                "name": node.name,
                "kind": kind,
                "start": node.lineno,
                "end": node.end_lineno,
                "references": references,
            }
        )

    print(json.dumps({"chunks": chunks}))


if __name__ == "__main__":
    main()
