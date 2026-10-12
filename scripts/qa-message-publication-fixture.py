"""Private all-writer journal prototype: owned PostgreSQL, real crash recovery."""
import json, os, socket, subprocess, tempfile
from pathlib import Path
root = Path(__file__).resolve().parent.parent
pg = Path(os.environ["PG_BIN"]).resolve()
owned = Path(tempfile.mkdtemp(prefix="dimle-publication-"))
data, sock = owned / "data", owned / "sock"
sock.mkdir()
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
env = {k:v for k,v in os.environ.items() if not k.startswith("PG") and k not in ("DATABASE_URL","RESUME_TEST_DATABASE_URL")}
env.update(OWNED_PG_PORT=str(port),RESUME_TEST_DATABASE_URL=f"postgresql://dimle@127.0.0.1:{port}/postgres",DIMLE_PUBLICATION_PROTOTYPE="1")
steps = []
def run(args, timeout=45):
    p = subprocess.run([str(x) for x in args], cwd=root, env=env, text=True, capture_output=True, timeout=timeout)
    steps.append(dict(command=[str(x) for x in args],exit=p.returncode,stdout=p.stdout,stderr=p.stderr))
    return p
def start():
    run([pg/"pg_ctl","-D",data,"-l",owned/"server.log","-o",f"-h 127.0.0.1 -p {port} -k {sock}","-w","start"]).check_returncode()
try:
    run([pg/"initdb","-D",data,"-U","dimle","--auth-local=trust","--auth-host=trust","--encoding=UTF8","--locale=C"]).check_returncode()
    start()
    run(["node","--import","tsx","scripts/qa-message-publication.ts","seed"]).check_returncode()
    run(["node","--import","tsx","scripts/qa-publication-subscriber.ts","seed"]).check_returncode()
    run(["node","--import","tsx","scripts/qa-resume-store.ts"],timeout=90).check_returncode()
    run([pg/"pg_ctl","-D",data,"-m","immediate","-w","stop"]).check_returncode()
    start()
    run(["node","--import","tsx","scripts/qa-message-publication.ts","recover"]).check_returncode()
    run(["node","--import","tsx","scripts/qa-publication-subscriber.ts","recover"]).check_returncode()
finally:
    if run([pg/"pg_ctl","-D",data,"status"]).returncode == 0:
        run([pg/"pg_ctl","-D",data,"-m","fast","-w","stop"]).check_returncode()
    final = run([pg/"pg_ctl","-D",data,"status"])
    print(json.dumps(dict(cluster=str(owned),steps=steps),indent=2))
    assert final.returncode == 3
