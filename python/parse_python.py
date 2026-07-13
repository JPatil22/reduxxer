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


def collect_imports(tree: ast.Module) -> dict:
    """Maps each name bound by a `from X import Y` to how to reach it:
    {local_name: {"level": int, "module": str|None, "original": str}}.
    (Path resolution happens on the Node side, which knows the file path.)
    Only `from ... import name` forms are tracked — `import x` then `x.y()`
    is an attribute call, which we don't resolve."""
    imports = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                local = alias.asname or alias.name
                imports[local] = {
                    "level": node.level,
                    "module": node.module,
                    "original": alias.name,
                }
    return imports


def deps_for(node: ast.AST, self_name: str, top_level_names: set, imports: dict) -> tuple:
    """Splits a node's calls into same-file references (bare top-level names)
    and external references (imported symbols, with resolution info for the
    Node side to turn into file paths)."""
    called = called_names(node)
    references = sorted(called & top_level_names - {self_name})
    external = []
    for nm in sorted(called):
        if nm in top_level_names:
            continue
        info = imports.get(nm)
        if info:
            external.append(
                {"name": info["original"], "level": info["level"], "module": info["module"]}
            )
    return references, external


def emit_class(node: ast.ClassDef, top_level_names: set, imports: dict) -> list:
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
            "external": [],
        }
    ]
    for m in methods:
        kind = "async-method" if isinstance(m, ast.AsyncFunctionDef) else "method"
        references, external = deps_for(m, node.name, top_level_names, imports)
        chunks.append(
            {
                "name": f"{node.name}.{m.name}",
                "kind": kind,
                "start": node_start(m),
                "end": m.end_lineno,
                "references": references,
                "external": external,
            }
        )
    return chunks


def parse_source(source: str) -> dict:
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"error": str(e)}

    imports = collect_imports(tree)
    defs = [
        node
        for node in tree.body
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef, ast.ClassDef))
    ]
    top_level_names = {node.name for node in defs}

    chunks = []

    # Module-header chunk: the top-of-file region (imports + module-level
    # constants/config) before the first def, so "what does this import" and
    # top-level config questions have something to match instead of forcing a
    # whole-file read.
    header_end = (min(node_start(d) for d in defs) - 1) if defs else 0
    header_stmts = [
        n
        for n in tree.body
        if isinstance(n, (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign))
        and (header_end == 0 or n.lineno <= header_end)
    ]
    if header_stmts:
        end = header_end if header_end > 0 else max(n.end_lineno for n in header_stmts)
        chunks.append(
            {
                "name": "__module__",
                "kind": "module",
                "start": 1,
                "end": end,
                "references": [],
                "external": [],
            }
        )
    for node in defs:
        if isinstance(node, ast.ClassDef):
            chunks.extend(emit_class(node, top_level_names, imports))
        else:
            kind = "async-function" if isinstance(node, ast.AsyncFunctionDef) else "function"
            references, external = deps_for(node, node.name, top_level_names, imports)
            chunks.append(
                {
                    "name": node.name,
                    "kind": kind,
                    "start": node_start(node),
                    "end": node.end_lineno,
                    "references": references,
                    "external": external,
                }
            )
    return {"chunks": chunks}


def main() -> None:
    if "--worker" in sys.argv:
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                source = data["content"]
                result = parse_source(source)
                print(json.dumps(result))
                sys.stdout.flush()
            except Exception as e:
                print(json.dumps({"error": str(e)}))
                sys.stdout.flush()
    else:
        source = sys.stdin.read()
        result = parse_source(source)
        print(json.dumps(result))


if __name__ == "__main__":
    main()

