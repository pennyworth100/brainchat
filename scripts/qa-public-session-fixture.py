"""Opt-in disposable PostgreSQL owner. Requires PG_BIN with initdb and pg_ctl."""
import json
import sys
import os
from pathlib import Path
import socket
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
pg = Path(os.environ["PG_BIN"]).resolve()
owned = Path(tempfile.mkdtemp(prefix="dimle-public-session-"))
data, sock = owned / "data", owned / "sock"
sock.mkdir()
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
# Never inherit managed credentials/connection routing; no DATABASE_URL fallback.
env = {k: v for k, v in os.environ.items()
       if not k.startswith("PG") and k not in ("DATABASE_URL", "RESUME_TEST_DATABASE_URL", "OWNED_PUBLICATION_PROOF")}
env.update(OWNED_PG_PORT=str(port),
           RESUME_TEST_DATABASE_URL=f"postgresql://dimle@127.0.0.1:{port}/postgres",
           NO_PROXY="127.0.0.1,localhost,::1")
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    app_port = probe.getsockname()[1]
uploads = owned / "uploads"
uploads.mkdir()
env.update(OWNED_APP_PORT=str(app_port), OWNED_UPLOAD_DIR=str(uploads))
if "--publication" in sys.argv:
    env["OWNED_PUBLICATION_PROOF"] = "1"
steps = []

def run(args, timeout=45):
    result = subprocess.run([str(x) for x in args], cwd=root, env=env,
                            capture_output=True, text=True, timeout=timeout)
    steps.append(dict(command=[str(x) for x in args], returncode=result.returncode,
                      stdout=result.stdout, stderr=result.stderr))
    return result

try:
    run([pg / "initdb", "-D", data, "-U", "dimle", "--auth-local=trust",
         "--auth-host=trust", "--encoding=UTF8", "--locale=C"]).check_returncode()
    run([pg / "pg_ctl", "-D", data, "-l", owned / "server.log", "-o",
         f"-h 127.0.0.1 -p {port} -k {sock}", "-w", "start"]).check_returncode()
    script = ("scripts/qa-public-upload-outcome.ts" if "--upload-outcome" in sys.argv else
              "scripts/qa-process-shutdown.ts" if "--shutdown" in sys.argv else
              "scripts/qa-startup-migrations.ts" if "--startup" in sys.argv else
              "scripts/qa-server-lifecycle.ts" if "--lifecycle" in sys.argv else
              "scripts/qa-public-session.ts")
    test = run(["node", "--import", "tsx", script], timeout=60)
    print(test.stdout, end="")
    print(test.stderr, end="")
    test.check_returncode()
    if "--publication" in sys.argv:
        # Server has settled and exited; crash/recover only this owned database.
        # This is journal durability, NOT recovery of live production storage.
        run([pg / "pg_ctl", "-D", data, "-m", "immediate", "-w", "stop"]).check_returncode()
        run([pg / "pg_ctl", "-D", data, "-l", owned / "server.log", "-o",
             f"-h 127.0.0.1 -p {port} -k {sock}", "-w", "start"]).check_returncode()
        recovered = run(["node", "--input-type=module", "-e",
                         """import assert from 'node:assert/strict'; import pg from 'pg';
                         const url = new URL(process.env.RESUME_TEST_DATABASE_URL);
                         assert.equal(url.hostname, '127.0.0.1');
                         assert.equal(url.port, process.env.OWNED_PG_PORT);
                         const db = new pg.Pool({connectionString: url.href});
                         try { const result = await db.query(`SELECT count(*) > 0 AND
                         count(*) = (SELECT count(*) FROM message_publication_pending) AND
                         count(*) = (SELECT count(*) FROM messages m JOIN message_publication_pending p
                           ON p.message_id=m.id AND p.room_id=m.room_id)
                         AS recovered FROM messages`);
                         assert.equal(result.rows[0].recovered, true); console.log('t');
                         } finally { await db.end(); }"""])
        recovered.check_returncode()
        assert recovered.stdout.strip() == "t", "Actual producer journal recovery mismatch"
        print("PUBLIC_PRODUCER_JOURNAL_RECOVERY_PASS: nonempty exact same-room journal survives immediate DB stop/restart")
finally:
    # Also handle partial/failed startup; pg_ctl consults this owned data directory.
    status = run([pg / "pg_ctl", "-D", data, "status"])
    if status.returncode == 0:
        run([pg / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"]).check_returncode()
    final = run([pg / "pg_ctl", "-D", data, "status"])
    print(json.dumps(dict(cluster=str(owned), steps=steps), indent=2))
    assert final.returncode == 3, "Owned PostgreSQL still running or cleanup unverifiable"
