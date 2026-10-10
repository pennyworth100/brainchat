"""Create an owned, disposable loopback PostgreSQL TLS cluster; never use live PG.

PG_BIN must name a directory containing initdb and pg_ctl.
Run as a non-root user with Python 3, OpenSSL and Node on PATH.
Only generated fixture credentials/certificates are used. Logs are retained.
"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, text=True, capture_output=True,
                          timeout=120, **kwargs)


def main():
    pg = Path(os.environ["PG_BIN"]).resolve(strict=True)
    for binary in ("initdb", "pg_ctl"):
        assert (pg / binary).is_file(), binary
    fixture = Path(tempfile.mkdtemp(prefix="dimle-provider-tls-", dir="/tmp")).resolve()
    data = fixture / "data"
    started = False
    report = {"fixture": str(fixture), "status": "FAIL"}
    def interrupted(signum, frame):
        raise RuntimeError("Fixture interrupted: " + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    try:
        run([str(pg / "initdb"), "-D", str(data), "-U", "dimle", "--auth=trust", "--no-locale", "--encoding=UTF8"])
        run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
             "-keyout", str(fixture / "server.key"), "-out", str(fixture / "server.crt")])
        (fixture / "server.key").chmod(0o600)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        # These are generated runtime fixture files, never an existing cluster.
        (data / "pg_hba.conf").write_text("hostssl all all 127.0.0.1/32 trust\nhost all all 0.0.0.0/0 reject\n")
        with (data / "postgresql.conf").open("a") as config:
            config.write("\nlisten_addresses='127.0.0.1'\nunix_socket_directories=''\n"
                         f"port={port}\nssl=on\nssl_cert_file='{fixture}/server.crt'\n"
                         f"ssl_key_file='{fixture}/server.key'\nlog_statement='all'\n"
                         "log_line_prefix='%m [%p] '\nlogging_collector=off\n")
        (fixture / "fixture.json").write_text(json.dumps({"port": port,
                                                         "kind": "owned-disposable-tls-v1"}))
        # If startup fails/gets interrupted after spawning, finally still stops OUR data dir.
        started = True
        run([str(pg / "pg_ctl"), "-D", str(data), "-l", str(fixture / "server.log"), "-w", "-t", "15", "start"])
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        env["LEDGER_TLS_FIXTURE"] = str(fixture)
        result = run(["node", "--import", "tsx", "scripts/qa-upload-ledger-provider.ts"],
                     cwd=Path(__file__).resolve().parent.parent, env=env)
        report.update(json.loads(result.stdout))
    except subprocess.CalledProcessError as error:
        report["error"] = {"exit": error.returncode, "stdout": error.stdout, "stderr": error.stderr}
        raise
    finally:
        if started:
            try:
                run([str(pg / "pg_ctl"), "-D", str(data), "-m", "immediate", "-w", "-t", "15", "stop"])
                report["clusterStopped"] = True
            except subprocess.CalledProcessError:
                # Startup failure is already fatal; never operate on another data dir.
                report["clusterStopped"] = not (data / "postmaster.pid").exists()
        (fixture / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
        if started and not report.get("clusterStopped"):
            raise RuntimeError("Owned fixture could not be stopped: " + str(fixture))


if __name__ == "__main__":
    main()
