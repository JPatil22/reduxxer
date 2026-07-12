"""
Reads Python source from stdin, parses it with the standard library `ast`
module (real parsing, not regex/text matching), and prints JSON describing
each top-level function/class: name, kind, 1-indexed line range, and which
other top-level symbols in this same file it calls (for one-hop dependency
expansion in search — see IndexStore.search in src/store.ts).

Classes are split like the TS indexer does: a compact "header" chunk (the
class signature + class-level attributes, up to the first method) plus one
chunk per method — so a query can match the specific method instead of the
whole class blob.

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


def node_start(node: ast.AST) -> int:
    """First line of a def, counting any decorators above it."""
    decorators = getattr(node, "decorator_list", None)
    if decorators:
        return min(d.lineno for d in decorators)
    return node.lineno


def emit_class(node: ast.ClassDef, top_level_names: set) -> list:
    """A class header chunk (signature + class-level attributes) plus one
    chunk per method."""
    methods = [b for b in node.body if isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef))]
    header_end = (node_start(methods[0]) - 1) if methods else node.end_lineno
    chunks = [
        {
            "name": node.name,
            "kind": "class",
            "start": node.lineno,
            "end": max(header_end, node.lineno),
            "references": [],
        }
    ]
    for m in methods:
        kind = "async-method" if isinstance(m, ast.AsyncFunctionDef) else "method"
        references = sorted(called_names(m) & top_level_names - {node.name})
        chunks.append(
            {
                "name": f"{node.name}.{m.name}",
                "kind": kind,
                "start": node_start(m),
                "end": m.end_lineno,
                "references": references,
            }
        )
    return chunks


def main() -> None:
    source = sys.stdin.read()
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        print(json.dumps({"error": str(e)}))
        return

    defs = [
        node
        for node in tree.body
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef, ast.ClassDef))
    ]
    top_level_names = {node.name for node in defs}

    chunks = []
    for node in defs:
        if isinstance(node, ast.ClassDef):
            chunks.extend(emit_class(node, top_level_names))
        else:
            kind = "async-function" if isinstance(node, ast.AsyncFunctionDef) else "function"
            references = sorted(called_names(node) & top_level_names - {node.name})
            chunks.append(
                {
                    "name": node.name,
                    "kind": kind,
                    "start": node_start(node),
                    "end": node.end_lineno,
                    "references": references,
                }
            )

    print(json.dumps({"chunks": chunks}))


if __name__ == "__main__":
    main()
