#!/usr/bin/env python3
"""Build the JARVIS knowledge-map aggregate.

For each repo in registry.json: if a real ``path`` exists on this box, scan the
source for code entities (functions/classes -> nodes) and import/reference lines
(-> edges) as a lightweight stand-in for a full graphify graph. Repos not present
on the box keep their grounded registry values. Writes aggregate.json, which
``/api/control/knowledge_graph`` serves. Re-runnable (cron-refreshable); full
graphify graphs can replace measured entries later.
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

GRAPH_DIR = Path.home() / ".hermes" / "jarvis" / "graph"
REG = GRAPH_DIR / "registry.json"
OUT = GRAPH_DIR / "aggregate.json"

EXTS = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb"}
SKIP = {
    "node_modules", "venv", ".venv", "dist", "web_dist", ".git", "__pycache__",
    "evals", "datagen-config-examples", "mcp-research-data", "website", "tests",
    "tests-js", "locales", "assets", "docs",
}
DEF_RE = re.compile(
    r"^\s*(def\s|class\s|function\s|async\s+function\s|export\s+(default\s+)?(async\s+)?function\s|"
    r"export\s+(default\s+)?class\s|[A-Za-z0-9_]+\s*=\s*(async\s*)?\([^)]*\)\s*=>|"
    r"const\s+[A-Za-z0-9_]+\s*=\s*(async\s*)?(\(|function))"
)
IMP_RE = re.compile(r"^\s*(import\s|from\s+[.\w]+\s+import\s|const\s+.+=\s*require\(|export\s+.+\s+from\s)")


def scan(path: str):
    nodes = edges = files = 0
    for root, dirs, fs in os.walk(path):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.endswith(".egg-info")]
        for f in fs:
            if os.path.splitext(f)[1] not in EXTS:
                continue
            files += 1
            try:
                with open(os.path.join(root, f), encoding="utf-8", errors="ignore") as fh:
                    for line in fh:
                        if DEF_RE.match(line):
                            nodes += 1
                        elif IMP_RE.match(line):
                            edges += 1
            except OSError:
                pass
    return files, nodes, edges


def main():
    reg = json.loads(REG.read_text(encoding="utf-8"))
    repos = []
    for r in reg["repos"]:
        item = {
            "name": r["name"],
            "domain": r["domain"],
            "top": r.get("top"),
            "concepts": r.get("concepts", []),
        }
        path = r.get("path")
        if path and os.path.isdir(path):
            files, nodes, edges = scan(path)
            item["nodes"] = nodes
            item["edges"] = nodes + edges  # intra-module refs approximated by defs + imports
            item["files"] = files
            item["measured"] = True
        else:
            item["nodes"] = r.get("nodes", 50)
            item["edges"] = r.get("edges", 100)
            item["measured"] = False
        repos.append(item)
    agg = {
        "repos": repos,
        "totals": {
            "repos": len(repos),
            "nodes": sum(x["nodes"] for x in repos),
            "edges": sum(x["edges"] for x in repos),
        },
        "measured": sum(1 for x in repos if x.get("measured")),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(agg, indent=2), encoding="utf-8")
    print(json.dumps({"totals": agg["totals"], "measured": agg["measured"]}))


if __name__ == "__main__":
    main()
