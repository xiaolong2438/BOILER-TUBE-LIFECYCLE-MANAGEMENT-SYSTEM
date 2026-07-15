#!/usr/bin/env python3
from __future__ import annotations

import json
import pathlib
import sys
from typing import Iterable


USERS_TABLE_SQL = """CREATE TABLE users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);"""

SESSIONS_TABLE_SQL = """CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);"""

INDEX_SQL = """CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);"""


def load_payload(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))


def iter_rows(node) -> Iterable[dict]:
    if isinstance(node, dict):
        if isinstance(node.get("name"), str):
            yield node
        for value in node.values():
            yield from iter_rows(value)
    elif isinstance(node, list):
        for value in node:
            yield from iter_rows(value)


def load_columns(path: pathlib.Path) -> list[dict[str, str]]:
    payload = load_payload(path)
    columns: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in iter_rows(payload):
        name = row.get("name")
        if isinstance(name, str) and name and name not in seen:
            seen.add(name)
            columns.append(
                {
                    "name": name,
                    "type": str(row.get("type") or ""),
                    "pk": str(row.get("pk") or "0"),
                }
            )
    return columns


def is_text_like(column: dict[str, str]) -> bool:
    column_type = column.get("type", "").upper()
    return not column_type or "CHAR" in column_type or "CLOB" in column_type or "TEXT" in column_type


def find_column(columns: list[dict[str, str]], names: Iterable[str]) -> dict[str, str] | None:
    lookup = {column["name"]: column for column in columns}
    for name in names:
        column = lookup.get(name)
        if column and is_text_like(column):
            return column
    return None


def table_sql(table: str) -> str:
    if table == "users":
        return USERS_TABLE_SQL
    if table == "sessions":
        return SESSIONS_TABLE_SQL
    raise ValueError(table)


def repair_table_sql(table: str, columns: list[dict[str, str]]) -> str:
    if not columns:
        return table_sql(table)

    if table == "users":
        if any(column["name"] == "username" for column in columns):
            return ""
        alias = find_column(columns, ("id", "name", "user_name", "login"))
        if alias:
            return f"ALTER TABLE users RENAME COLUMN {alias['name']} TO username;"
        return "PRAGMA foreign_keys=OFF;\nALTER TABLE users RENAME TO users_legacy;\n" + USERS_TABLE_SQL + "\nPRAGMA foreign_keys=ON;"

    if table == "sessions":
        if any(column["name"] == "username" for column in columns):
            return ""
        alias = find_column(columns, ("user_id", "user", "login", "account"))
        if alias:
            return f"ALTER TABLE sessions RENAME COLUMN {alias['name']} TO username;"
        return "PRAGMA foreign_keys=OFF;\nALTER TABLE sessions RENAME TO sessions_legacy;\n" + SESSIONS_TABLE_SQL + "\n" + INDEX_SQL + "\nPRAGMA foreign_keys=ON;"

    raise ValueError(table)


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "Usage: repair_auth_schema.py <users-columns-json> <sessions-columns-json>",
            file=sys.stderr,
        )
        return 1

    users_path = pathlib.Path(sys.argv[1])
    sessions_path = pathlib.Path(sys.argv[2])

    users_columns = load_columns(users_path)
    sessions_columns = load_columns(sessions_path)

    statements = [repair_table_sql("users", users_columns), repair_table_sql("sessions", sessions_columns)]
    statements = [statement for statement in statements if statement.strip()]

    if not statements:
        return 0

    print(";\n".join(statement.rstrip(";") for statement in statements) + ";")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
