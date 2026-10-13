"""Actual catalog drift with unchanged migration history, owned loopback only."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlsplit, unquote

root = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("catalog", root / "production/catalog-fingerprint.py")
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)
connection = os.environ["RESUME_TEST_DATABASE_URL"]
url = urlsplit(connection)
assert url.hostname == "127.0.0.1" and url.port == int(os.environ["OWNED_PG_PORT"]) and not url.query
pg_bin = os.environ["CATALOG_PG_BIN"]
env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
env.update(PGHOST=url.hostname, PGPORT=str(url.port), PGUSER=unquote(url.username),
           PGPASSWORD=unquote(url.password or ""), PGDATABASE=unquote(url.path[1:]), PGSSLMODE="disable")

def sql(text):
    r = subprocess.run([str(Path(pg_bin) / "psql"), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"],
                       input=text, env=env, text=True, capture_output=True, timeout=15)
    assert r.returncode == 0, "Owned catalog fixture SQL failed: " + r.stderr
    return r.stdout.strip()

def digest():
    return catalog.fingerprint(pg_bin, connection, fixture_port=url.port)["sha256"]

history = sql("SELECT md5(string_agg(hash || ':' || created_at::text, ',' ORDER BY id)) FROM drizzle.__drizzle_migrations;")
baseline = digest()
assert baseline == digest(), "Per-run dump nonce must not cause drift"
cases = [
    ("trigger-disabled", "ALTER TABLE messages DISABLE TRIGGER message_admission_after_insert", "ALTER TABLE messages ENABLE TRIGGER message_admission_after_insert"),
    ("index-missing", "DROP INDEX message_publication_room", "CREATE INDEX message_publication_room ON message_publication_pending(room_id,message_id)"),
    ("column-added", "ALTER TABLE rooms ADD COLUMN unexpected text", "ALTER TABLE rooms DROP COLUMN unexpected"),
    ("function-security", "ALTER FUNCTION admit_message_write() SECURITY INVOKER", "ALTER FUNCTION admit_message_write() SECURITY DEFINER"),
    ("extra-schema", "CREATE SCHEMA unexpected; CREATE TABLE unexpected.hidden(id int)", "DROP SCHEMA unexpected CASCADE"),
    ("rls-enabled", "ALTER TABLE messages ENABLE ROW LEVEL SECURITY", "ALTER TABLE messages DISABLE ROW LEVEL SECURITY"),
]
passed = []
for name, change, restore in cases:
    sql(change)
    try:
        assert digest() != baseline, name + " was not detected"
        assert sql("SELECT md5(string_agg(hash || ':' || created_at::text, ',' ORDER BY id)) FROM drizzle.__drizzle_migrations;") == history
    finally:
        sql(restore)
    assert digest() == baseline, name + " restoration changed schema"
    passed.append(name)
try:
    catalog.fingerprint(pg_bin, "postgresql://example.invalid/db?sslmode=disable")
    raise AssertionError("Insecure connection override accepted")
except ValueError:
    pass
bad_env = dict(os.environ, DIMLE_CATALOG_DATABASE_URL="postgresql://fixture:never-print-this@invalid:5432/db?sslmode=disable")
bad = subprocess.run(["python3", str(root / "production/catalog-fingerprint.py"),
                      "--pg-bin", pg_bin, "--ca-file", "/missing-root",
                      "--expected-sha256", baseline], env=bad_env, capture_output=True, text=True, timeout=5)
assert bad.returncode == 1 and "never-print-this" not in bad.stdout + bad.stderr
assert json.loads(bad.stdout)["status"] == "FAIL"
print(json.dumps({"status": "PASS", "driftDetected": passed, "historyUnchanged": True,
                  "baselineSha256": baseline, "repeatable": True, "tlsOverrideRefused": True,
                  "cliSanitizedRefusal": True,
                  "productionApplied": False}))
