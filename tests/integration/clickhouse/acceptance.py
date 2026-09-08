# SPDX-License-Identifier: Apache-2.0
"""Packaged Collector-to-Meridian conformance with task-owned stock containers."""

import copy
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time

import clickhouse_connect
import yaml

from fixtures import PAYLOADS
from mapping_layout import build, apply, inspect_records

STATES = {mode: build(mode) for mode in ("gateway", "sidecar")}
RUNTIMES = []
PLUGIN_VOLUME = "meridian-collector-plugin-" + str(os.getpid())
SETTINGS = {}

SCRIPTS = Path(__file__).resolve().parent
ROOT = Path(os.environ["MERIDIAN_ACCEPTANCE_EVIDENCE_DIR"]).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
COLLECTOR = "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6"
BACKEND = "clickhouse/clickhouse-server@sha256:0152dd511befe6a2c2ef53e930726179669b08116da78500b37c51c96ff5ee77"
PYTHON = "python@sha256:32e2c347413bae52d567e2cc3eef31cd617a83dcac51644caadc0bbac131395a"

REPORT = {
    "images": {"collector": COLLECTOR, "backend": BACKEND, "sender": PYTHON},
    "scope": "Installed npm plan, real public plugin, strict Meridian startup/read, canonical identity and durable fault acceptance",
    "checks": [],
    "backendMemoryLimit": "2 GiB",
    "collectorMemoryLimit": "256 MiB per mode",
}


def run(args, input=None):
    p = subprocess.run(args, input=input, capture_output=True, text=True, timeout=90)
    if p.returncode:
        raise RuntimeError(f"command failed: {args[:4]}: {p.stderr[-1200:]}")
    return p.stdout


def wait(label, fn, seconds=45):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            result = fn()
            if result:
                return result
        except Exception as e:
            last = type(e).__name__
        time.sleep(0.5)
    raise RuntimeError(f"{label}: deadline ({last})")


def attr(key, kind, value):
    return {"key": key, "value": {kind: value}}


def payload(signal):
    return copy.deepcopy(PAYLOADS[signal])


SENDER = """import json,ssl,sys,urllib.request,urllib.error
p=json.load(sys.stdin)
c=ssl.create_default_context(cafile='/tls/cert.pem')
if p['identity']: c.load_cert_chain('/tls/cert.pem','/tls/key.pem')
try:
 r=urllib.request.urlopen(urllib.request.Request(p['url'],data=(p['body'].encode() if p.get('raw') else json.dumps(p['body']).encode()),headers={'Content-Type':'application/json'}),context=c,timeout=5)
 print(json.dumps({'status':r.status,'body':r.read().decode()}))
except urllib.error.HTTPError as e: print(json.dumps({'status':e.code,'body':e.read().decode()}))
except Exception as e: print(json.dumps({'status':0,'error':type(e).__name__}))
"""

with tempfile.TemporaryDirectory(prefix="t100656-collector-") as tmp:
    work = Path(tmp)
    tls = work / "tls"
    tls.mkdir()
    run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,DNS:backend,IP:127.0.0.1",
            "-keyout",
            str(tls / "key.pem"),
            "-out",
            str(tls / "cert.pem"),
        ]
    )
    for path in tls.iterdir():
        path.chmod(0o644)
    (work / "tls.xml").write_text(
        "<clickhouse><https_port>8443</https_port><tcp_port_secure>9440</tcp_port_secure><openSSL><server><certificateFile>/tls/cert.pem</certificateFile><privateKeyFile>/tls/key.pem</privateKeyFile><verificationMode>none</verificationMode><cacheSessions>true</cacheSessions></server></openSSL></clickhouse>"
    )
    sockets = [socket.socket() for _ in range(2)]
    for sock in sockets:
        sock.bind(("127.0.0.1", 0))
    backend_port, gateway_port = [sock.getsockname()[1] for sock in sockets]
    services = {
        "backend": {
            "image": BACKEND,
            "ports": [f"127.0.0.1:{backend_port}:8443"],
            "environment": {
                "CLICKHOUSE_USER": "meridian",
                "CLICKHOUSE_PASSWORD": "meridian-test",
                "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT": "1",
            },
            "volumes": [
                f"{tls}:/tls:ro",
                f"{work}/tls.xml:/etc/clickhouse-server/config.d/tls.xml:ro",
                "backend-data:/var/lib/clickhouse",
            ],
            "mem_limit": "2g",
            "labels": {"task": "t100656"},
        }
    }
    for mode in ("gateway", "sidecar"):
        conf = STATES[mode][2]["collector"]["config"]
        (work / (mode + ".yaml")).write_text(yaml.safe_dump(conf, sort_keys=False))
        (ROOT / ("full-mapping-" + mode + ".config.json")).write_text(
            json.dumps(conf, indent=2) + "\n"
        )
        services[mode] = {
            "image": COLLECTOR,
            "user": "0",
            "command": STATES[mode][2]["commandArguments"] + ["--config=/config.yaml"],
            "volumes": [
                f"{work}/{mode}.yaml:/config.yaml:ro",
                f"{tls}:/tls:ro",
                mode + "-queue:/queue",
            ],
            "environment": {
                "CLICKHOUSE_USER": "meridian",
                "CLICKHOUSE_PASSWORD": "meridian-test",
                "COLLECTOR_RELAY": "local-synthetic-relay",
            },
            "mem_limit": "256m",
            "labels": {"task": "t100656"},
            **({"ports": [f"127.0.0.1:{gateway_port}:4318"]} if mode == "gateway" else {}),
        }
    compose = work / "compose.yaml"
    compose.write_text(
        yaml.safe_dump(
            {
                "services": services,
                "volumes": {
                    name: {} for name in ("backend-data", "gateway-queue", "sidecar-queue")
                },
            }
        )
    )
    command = ["docker", "compose", "-p", "t100656-full-mapping", "-f", str(compose)]
    for sock in sockets:
        sock.close()
    client = None
    try:
        run(
            [
                "docker",
                "volume",
                "create",
                "--label",
                "purpose=collector-public-plugin-acceptance",
                PLUGIN_VOLUME,
            ]
        )
        install = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--label",
                "task=t100656",
                "-v",
                PLUGIN_VOLUME + ":/runtime",
                "-v",
                str(SCRIPTS) + ":/runner:ro",
                "-v",
                str(ROOT) + ":/evidence",
                PYTHON,
                "python",
                "-m",
                "pip",
                "install",
                "--target",
                "/runtime",
                "--report",
                "/evidence/linux-public-install.json",
                "-r",
                "/runner/requirements.txt",
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
        assert install.returncode == 0, install.stderr[-2000:]
        run(command + ["up", "-d", "backend"])

        def ready():
            global client
            client = clickhouse_connect.get_client(
                host="localhost",
                port=backend_port,
                username="meridian",
                password="meridian-test",
                secure=True,
                verify=True,
                ca_cert=str(tls / "cert.pem"),
                connect_timeout=2,
                send_receive_timeout=45,
            )
            return client.command("SELECT version()")

        REPORT["backendObserved"] = wait("backend", ready)
        for mode in ("gateway", "sidecar"):
            runtime, settings, report = apply(
                client, mode, STATES[mode], backend_port, tls / "cert.pem"
            )
            RUNTIMES.append(runtime)
            SETTINGS[mode] = settings
            REPORT.setdefault("runtimeStartup", []).append(report.to_dict())
        run(command + ["up", "-d", "gateway", "sidecar"])

        def send(mode, signal, body, identity=True, raw=False):
            request = {
                "url": f"https://localhost:{gateway_port if mode == 'gateway' else 4318}/v1/{signal}",
                "body": body,
                "identity": identity,
                "raw": raw,
            }
            if mode == "sidecar":
                container = run(command + ["ps", "-q", "sidecar"]).strip()
                return json.loads(
                    run(
                        [
                            "docker",
                            "run",
                            "--rm",
                            "-i",
                            "--label",
                            "task=t100656",
                            "--network",
                            "container:" + container,
                            "-v",
                            f"{tls}:/tls:ro",
                            PYTHON,
                            "python",
                            "-c",
                            SENDER,
                        ],
                        input=json.dumps(request),
                    )
                )
            local = SENDER.replace("'/tls/cert.pem'", repr(str(tls / "cert.pem"))).replace(
                "'/tls/key.pem'", repr(str(tls / "key.pem"))
            )
            return json.loads(run([os.sys.executable, "-c", local], input=json.dumps(request)))

        def queue_size(mode):
            container = run(command + ["ps", "-q", mode]).strip()
            probe = """import json,re,urllib.request
text=urllib.request.urlopen('http://127.0.0.1:8888/metrics',timeout=3).read().decode()
rows=[line for line in text.splitlines() if line.startswith('otelcol_exporter_queue_size') and 'exporter="clickhouse"' in line]
assert len(rows)==1,rows
print(json.dumps(float(rows[0].split()[-1])))
"""
            return json.loads(
                run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--label",
                        "task=t100656",
                        "--network",
                        "container:" + container,
                        PYTHON,
                        "python",
                        "-c",
                        probe,
                    ]
                )
            )

        for mode in ("gateway", "sidecar"):
            wait(mode, lambda: send(mode, "logs", payload("logs"))["status"] == 200)
            assert send(mode, "logs", payload("logs"), False)["status"] == 0
            wait(
                mode + " first log",
                lambda: (
                    client.command(
                        "SELECT count() FROM "
                        + STATES[mode][0][0].layout.qualified_table("native_" + mode)
                        + " FINAL"
                    )
                    > 0
                ),
                90,
            )
            for index, signal in enumerate(("traces", "metrics"), 1):
                response = send(mode, signal, payload(signal))
                assert response["status"] == 200, response
                wait(
                    mode + " " + signal,
                    lambda: (
                        client.command(
                            "SELECT count() FROM "
                            + STATES[mode][0][index].layout.qualified_table("native_" + mode)
                            + " FINAL"
                        )
                        > 0
                    ),
                    90,
                )
            response = send(mode, "metrics", payload("histograms"))
            assert response["status"] == 200, response
            response = send(mode, "metrics", payload("additional"))
            assert response["status"] == 200, response
            records = {}
            for compilation in STATES[mode][0]:
                layout = compilation.layout
                table = layout.qualified_table("native_" + mode)
                wait(
                    mode + " " + layout.record_profile.value,
                    lambda: (
                        client.command("SELECT count() FROM " + table + " FINAL")
                        >= {"log": 1, "span": 1, "metric": 9}[layout.record_profile.value]
                    ),
                    90,
                )
                rows = client.query("SELECT * FROM " + table + " FINAL").named_results()
                records[layout.record_profile.value] = [dict(r) for r in rows]
            (ROOT / (mode + "-physical-records.json")).write_text(
                json.dumps(records, indent=2, default=str) + "\n"
            )
            REPORT["checks"].append(
                {
                    "mode": mode,
                    "storedCounts": {k: len(v) for k, v in records.items()},
                    "realMeridianStarted": True,
                }
            )
        for mode in ("gateway", "sidecar"):
            container = run(command + ["ps", "-q", mode]).strip()
            result = json.loads(
                run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "-i",
                        "--label",
                        "task=t100656",
                        "--network",
                        "container:" + container,
                        "-v",
                        f"{tls}:/tls:ro",
                        PYTHON,
                        "python",
                        "-c",
                        SENDER,
                    ],
                    input=json.dumps(
                        {
                            "url": "https://localhost:18180/events",
                            "body": payload("logs"),
                            "identity": False,
                        }
                    ),
                )
            )
            assert result["status"] in (401, 403), result
            REPORT.setdefault("privateRelayAuthentication", []).append(
                {"mode": mode, "missingCredentialRejected": result["status"]}
            )
        for index, mode in enumerate(("gateway", "sidecar")):
            REPORT.setdefault("publicReads", []).append(
                inspect_records(client, mode, STATES[mode], RUNTIMES[index], SETTINGS[mode])
            )
        from gates import (
            retry_and_negatives,
            durability,
            no_change_and_pins,
            canonical_float_contract,
        )

        REPORT["canonicalFloats"] = canonical_float_contract(client, STATES["gateway"])
        REPORT["retryAndNegatives"] = retry_and_negatives(
            send, client, STATES, RUNTIMES, SETTINGS, ROOT, wait
        )
        REPORT["noChangeAndPins"] = no_change_and_pins(
            client, STATES, RUNTIMES, SETTINGS, ROOT, tls / "cert.pem"
        )
        from datetime import datetime, timezone, timedelta
        from meridian_storage import OperationContext
        from meridian_storage.plugins.observability import EvidenceResources, TelemetryQueries

        for index, mode in enumerate(("gateway", "sidecar")):
            ca = str(tls / "cert.pem") if mode == "gateway" else "/tls/cert.pem"
            key = str(tls / "key.pem") if mode == "gateway" else "/tls/key.pem"
            plugin_input = {
                "runtimeConfig": json.loads((ROOT / (mode + "-runtime-config.json")).read_text()),
                "bundle": STATES[mode][1].to_dict(),
                "sidecar": mode == "sidecar",
                "mode": mode,
                "endpoint": f"https://localhost:{gateway_port if mode == 'gateway' else 4318}",
                "ca": ca,
                "key": key,
            }
            if mode == "gateway":
                outcome = json.loads(
                    run(
                        [os.sys.executable, str(SCRIPTS / "plugin_emit.py")],
                        input=json.dumps(plugin_input),
                    )
                )
            else:
                container = run(command + ["ps", "-q", "sidecar"]).strip()
                try:
                    outcome = json.loads(
                        run(
                            [
                                "docker",
                                "run",
                                "--rm",
                                "--name",
                                "t100656-plugin-sidecar",
                                "-i",
                                "--label",
                                "task=t100656",
                                "--network",
                                "container:" + container,
                                "-v",
                                f"{tls}:/tls:ro",
                                "-v",
                                str(SCRIPTS) + ":/runner:ro",
                                "-v",
                                PLUGIN_VOLUME + ":/runtime:ro",
                                "-e",
                                "PYTHONPATH=/runtime",
                                PYTHON,
                                "python",
                                "/runner/plugin_emit.py",
                            ],
                            input=json.dumps(plugin_input),
                        )
                    )
                finally:
                    subprocess.run(
                        ["docker", "rm", "-f", "t100656-plugin-sidecar"], capture_output=True
                    )
            resources = EvidenceResources(*(c.layout.resource for c in STATES[mode][0]))
            queries = TelemetryQueries(RUNTIMES[index], resources)
            start = datetime.now(timezone.utc) - timedelta(minutes=5)
            end = start + timedelta(minutes=10)
            context = OperationContext(
                "test:plugin-read", tenant="tenant-a", scope={"service": "collector-feasibility"}
            )

            def read_plugin():
                with RUNTIMES[index].context(context):
                    logs = [
                        dict(x)
                        for x in queries.logs(start=start, end=end).page(limit=100).execute().items
                    ]
                    spans = [
                        dict(x)
                        for x in queries.spans(start=start, end=end).page(limit=100).execute().items
                    ]
                    metrics = {
                        name: [
                            dict(x)
                            for x in queries.metric_series(name, start=start, end=end)
                            .page(limit=100)
                            .execute()
                            .items
                        ]
                        for name in ("plugin.gauge", "plugin.histogram", "plugin.counter")
                    }
                return (
                    {"logs": logs, "spans": spans, "metrics": metrics}
                    if logs and spans and all(metrics.values())
                    else None
                )

            observed = wait(mode + " plugin public reads", read_plugin, 90)
            assert observed["logs"][0]["attributes"]["large"] == 9007199254740993
            assert observed["spans"][0]["events"][0]["attributes"]["boolean"] is True
            assert observed["logs"][0]["traceId"] == observed["spans"][0]["traceId"]
            gauges = observed["metrics"]["plugin.gauge"]
            assert {r["value"] for r in gauges} == {9007199254740992, 9007199254740993} and all(
                type(r["value"]) is int for r in gauges
            )
            assert all(
                r["value"]["min"] == 0.25 and r["value"]["max"] == 0.25
                for r in observed["metrics"]["plugin.histogram"]
            )
            assert all(
                r["value"] == 2 and r["monotonic"] is True
                for r in observed["metrics"]["plugin.counter"]
            )
            (ROOT / (mode + "-plugin-public-records.json")).write_text(
                json.dumps(observed, indent=2) + "\n"
            )
            outcome["publicReadCounts"] = {
                "logs": len(observed["logs"]),
                "spans": len(observed["spans"]),
                "metrics": {k: len(v) for k, v in observed["metrics"].items()},
            }
            outcome["actualOtlpExporters"] = True
            REPORT.setdefault("realPlugin", []).append(outcome)
        REPORT["durability"] = durability(
            send, client, STATES, RUNTIMES, SETTINGS, command, run, ready, wait, queue_size
        )
        try:
            wrong = clickhouse_connect.get_client(
                host="localhost",
                port=backend_port,
                username="meridian",
                password="incorrect-test-password",
                secure=True,
                verify=True,
                ca_cert=str(tls / "cert.pem"),
                connect_timeout=2,
                send_receive_timeout=45,
            )
        except Exception as e:
            REPORT["wrongBackendCredentialRejected"] = type(e).__name__
        else:
            wrong.close()
            raise AssertionError("wrong backend credentials accepted")
        REPORT["outcome"] = (
            "PASS: installed Constructs, both real-plugin modes, typed public reads, canonical retry and acknowledged SIGKILL recovery"
        )
    except Exception as e:
        REPORT["failure"] = repr(e)
        raise
    finally:
        for runtime in RUNTIMES:
            runtime.close()
        if client:
            client.close()
        try:
            (ROOT / "full-mapping-collector.log").write_text(run(command + ["logs", "--no-color"]))
        finally:
            run(command + ["down", "-v", "--remove-orphans"])
            run(["docker", "volume", "rm", PLUGIN_VOLUME])
            REPORT["cleanup"] = (
                "task Docker containers, networks, volumes removed; temporary certificates/configuration removed"
            )
            (ROOT / "full-mapping-probe.json").write_text(json.dumps(REPORT, indent=2) + "\n")
print(json.dumps({"outcome": REPORT["outcome"], "modes": len(REPORT["checks"])}))
