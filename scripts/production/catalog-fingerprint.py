"""Read-only offline schema attestation; never an installer or startup bypass.

Compare only to a fingerprint generated from a disposable, independently built
release database using the same PostgreSQL server and pg_dump versions.
Credentials stay in process environment; driver diagnostics are not printed.
Ownership, ACLs, data/history, capacity and writer fencing are separate gates.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit, unquote


def fingerprint(pg_bin, connection, ca_file=None, fixture_port=None):
    url = urlsplit(connection)
    if (url.scheme not in ("postgres", "postgresql") or not url.hostname or not url.username
            or not url.port or not url.path.strip("/") or url.query or url.fragment):
        raise ValueError("Explicit PostgreSQL URL without connection overrides required")
    local_fixture = (fixture_port is not None and url.hostname == "127.0.0.1"
                     and url.port == int(fixture_port))
    if not local_fixture and (not ca_file or not Path(ca_file).is_file()):
        raise ValueError("Verified TLS root required")
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env.update(PGHOST=url.hostname, PGPORT=str(url.port), PGUSER=unquote(url.username),
               PGPASSWORD=unquote(url.password or ""), PGDATABASE=unquote(url.path[1:]), PGCONNECT_TIMEOUT="10",
               PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000",
               PGGSSENCMODE="disable", PGSSLMODE="disable" if local_fixture else "verify-full")
    if not local_fixture:
        env["PGSSLROOTCERT"] = str(Path(ca_file).resolve())
    result = subprocess.run([str(Path(pg_bin) / "pg_dump"), "--schema-only",
                             "--no-owner", "--no-privileges", "--lock-wait-timeout=5s"],
                            env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Schema read failed; database diagnostics withheld")
    # PostgreSQL 17+ emits a per-run psql restriction nonce. Remove ONLY these
    # complete directive lines, never comments, whitespace, function bodies or
    # versions. Incompatible tool/server versions must fail closed too.
    lines = result.stdout.splitlines(keepends=True)
    directives = [line for line in lines if re.fullmatch(rb"\\(?:un)?restrict [A-Za-z0-9]+\r?\n", line)]
    if directives:
        if len(directives) != 2 or directives[0].split()[1] != directives[1].split()[1]:
            raise RuntimeError("Unexpected dump restriction framing")
    canonical = b"".join(line for line in lines if line not in directives)
    if b"CREATE TABLE" not in canonical or b"PostgreSQL database dump complete" not in canonical:
        raise RuntimeError("Incomplete release schema dump")
    return {"sha256": hashlib.sha256(canonical).hexdigest(), "bytes": len(canonical)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pg-bin", required=True)
    parser.add_argument("--ca-file", required=True)
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()
    if not re.fullmatch("[a-f0-9]{64}", args.expected_sha256):
        raise ValueError("Invalid release fingerprint")
    actual = fingerprint(args.pg_bin, os.environ["DIMLE_CATALOG_DATABASE_URL"], args.ca_file)
    if actual["sha256"] != args.expected_sha256:
        raise RuntimeError("Release schema mismatch")
    print(json.dumps({"status": "PASS", **actual, "readOnly": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"status": "FAIL", "reason": "Schema attestation rejected; no mutation performed"}))
        raise SystemExit(1)
