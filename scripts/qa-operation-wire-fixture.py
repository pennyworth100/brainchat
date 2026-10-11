"""Opt-in disposable PostgreSQL owner. Requires PG_BIN with initdb and pg_ctl."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
pg = Path(os.environ["PG_BIN"]).resolve()
owned = Path(tempfile.mkdtemp(prefix="dimle-operation-wire-"))
data, sock = owned / "data", owned / "sock"
sock.mkdir()
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
# Never inherit managed credentials/connection routing; no DATABASE_URL fallback.
env = {k: v for k, v in os.environ.items()
       if not k.startswith("PG") and k not in ("DATABASE_URL", "RESUME_TEST_DATABASE_URL")}
env.update(OWNED_PG_PORT=str(port),
           RESUME_TEST_DATABASE_URL=f"postgresql://dimle@127.0.0.1:{port}/postgres")
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
    test = run(["node", "--import", "tsx", "scripts/qa-operation-wire.ts"], timeout=40)
    print(test.stdout, end="")
    print(test.stderr, end="")
    test.check_returncode()
finally:
    # Also handle partial/failed startup; pg_ctl consults this owned data directory.
    status = run([pg / "pg_ctl", "-D", data, "status"])
    if status.returncode == 0:
        run([pg / "pg_ctl", "-D", data, "-m", "fast", "-w", "stop"]).check_returncode()
    final = run([pg / "pg_ctl", "-D", data, "status"])
    print(json.dumps(dict(cluster=str(owned), steps=steps), indent=2))
    assert final.returncode == 3, "Owned PostgreSQL still running or cleanup unverifiable"

