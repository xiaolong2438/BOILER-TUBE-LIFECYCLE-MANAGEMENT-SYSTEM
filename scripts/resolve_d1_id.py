#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import pathlib
import sys


def object_name(node: dict) -> str:
    for key in ("name", "database_name", "binding"):
        value = node.get(key)
        if value:
            return str(value)
    return ""


def object_id(node: dict) -> str:
    for key in ("uuid", "database_id", "id"):
        value = node.get(key)
        if value:
            return str(value)
    return ""


def find_id(node, name: str = "") -> str:
    if isinstance(node, dict):
        node_name = object_name(node)
        if name and node_name:
            if node_name != name:
                return ""
            found_id = object_id(node)
            if found_id:
                return found_id
        elif not name:
            found_id = object_id(node)
            if found_id:
                return found_id
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


UUID_PATTERN = re.compile(
    r"\b[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}\b"
)


def find_id_in_text(text: str, name: str = "") -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if name:
        for line in lines:
            if name.lower() in line.lower():
                match = UUID_PATTERN.search(line)
                if match:
                    return match.group(0)
        if name.lower() in text.lower():
            match = UUID_PATTERN.search(text)
            if match:
                return match.group(0)
        return ""
    for line in lines:
        match = UUID_PATTERN.search(line)
        if match:
            return match.group(0)
    return ""


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print("Usage: resolve_d1_id.py <json-file> [database-name]", file=sys.stderr)
        return 1
    path = pathlib.Path(sys.argv[1])
    name = sys.argv[2] if len(sys.argv) == 3 else ""
    raw = path.read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = None
    result = find_id(data, name) if data is not None else ""
    if not result:
        result = find_id_in_text(raw, name)
    if not result:
        return 0
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
