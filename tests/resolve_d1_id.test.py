import json
import pathlib
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "resolve_d1_id.py"
OLD_ID = "8553d7c8-edcf-4c03-8477-92419d2f9263"
NEW_ID = "b184c2f1-1111-4444-8888-abcdef123456"


def run_resolver(payload, database_name):
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as handle:
        json.dump(payload, handle)
        temp_path = handle.name
    try:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), temp_path, database_name],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        return result.stdout.strip()
    finally:
        pathlib.Path(temp_path).unlink(missing_ok=True)


def test_resolves_exact_database_name_without_using_first_id():
    payload = [
        {"database_name": "employee-certification-system", "uuid": OLD_ID},
        {"database_name": "boiler_tube_lifecycle_management_system", "uuid": NEW_ID},
    ]

    assert run_resolver(payload, "boiler_tube_lifecycle_management_system") == NEW_ID


def test_returns_empty_when_database_name_is_missing():
    payload = [{"database_name": "employee-certification-system", "uuid": OLD_ID}]

    assert run_resolver(payload, "boiler_tube_lifecycle_management_system") == ""


if __name__ == "__main__":
    test_resolves_exact_database_name_without_using_first_id()
    test_returns_empty_when_database_name_is_missing()
    print("resolve_d1_id tests passed")
