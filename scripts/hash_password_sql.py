#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import os
import sys


ITERATIONS = 210_000


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print("Usage: hash_password_sql.py <username> <password> [role]", file=sys.stderr)
        return 1
    username = sys.argv[1].strip()
    password = sys.argv[2].strip()
    role = sys.argv[3].strip().lower() if len(sys.argv) == 4 else 'admin'
    if not username:
        print("Username cannot be empty.", file=sys.stderr)
        return 1
    if len(password) < 8:
        print("Password must be at least 8 characters.", file=sys.stderr)
        return 1
    if role not in ('admin', 'user'):
        print("Role must be admin or user.", file=sys.stderr)
        return 1

    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS, dklen=32)
    salt_b64 = base64.b64encode(salt).decode("ascii")
    digest_b64 = base64.b64encode(digest).decode("ascii")

    print(
        "INSERT INTO users (username, role, password_hash, salt, iterations, updated_at) "
        f"VALUES ({sql_literal(username)}, {sql_literal(role)}, {sql_literal(digest_b64)}, {sql_literal(salt_b64)}, {ITERATIONS}, CURRENT_TIMESTAMP) "
        "ON CONFLICT(username) DO UPDATE SET "
        "role = excluded.role, "
        "password_hash = excluded.password_hash, "
        "salt = excluded.salt, "
        "iterations = excluded.iterations, "
        "updated_at = CURRENT_TIMESTAMP;"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
