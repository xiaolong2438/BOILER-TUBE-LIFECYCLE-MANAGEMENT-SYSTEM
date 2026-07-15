#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import sys


def find_id(node, name: str = "") -> str:
    if isinstance(node, dict):
        if name and node.get("name") and node.get("name") != name:
            return ""
        for key in ("uuid", "database_id", "id"):
            value = node.get(key)
            if value:
                return str(value)
        for value in node.values():
            found = find_id(value, name)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = find_id(value, name)
            if found:
                return found
    return ""


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print("Usage: resolve_d1_id.py <json-file> [database-name]", file=sys.stderr)
        return 1
    path = pathlib.Path(sys.argv[1])
    name = sys.argv[2] if len(sys.argv) == 3 else ""
    data = json.loads(path.read_text(encoding="utf-8"))
    result = find_id(data, name)
    if not result:
        return 0
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
