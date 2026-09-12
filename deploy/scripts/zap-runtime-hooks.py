import json
from pathlib import Path
from urllib.parse import urlparse

INVENTORY_PATH = Path("/zap/runtime-inventory.json")
COVERAGE_PATH = Path("/zap/wrk/seed-coverage.json")

inventory = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
active_surface = None


def _surface_for_target(target):
    for name, config in inventory["surfaces"].items():
        if config["origin"] == target.rstrip("/"):
            return name, config
    raise RuntimeError("target is absent from the checked-in DAST inventory")


def zap_started(zap, target):
    global active_surface
    name, config = _surface_for_target(target)
    active_surface = (name, config)
    print("DAST-HOOK-PHASE: seed-start", flush=True)
    host = urlparse(config["origin"]).netloc
    for route in config["routes"]:
        body = "{}" if route["method"] in {"POST", "PATCH"} else ""
        request = (
            f'{route["method"]} {config["origin"]}{route["seedPath"]} HTTP/1.1\r\n'
            f"Host: {host}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
            f"{body}"
        )
        # The generated client return shape has changed between ZAP API
        # releases. A request/API exception still aborts the hook, while the
        # post-scan message inventory below is the authoritative proof that
        # every seed was accepted into ZAP's site tree.
        zap.core.send_request(request, followredirects="false")
    print("DAST-HOOK-PHASE: seed-complete", flush=True)


def zap_pre_shutdown(zap):
    if active_surface is None:
        raise RuntimeError("DAST inventory was not seeded")
    print("DAST-HOOK-PHASE: coverage-start", flush=True)
    name, config = active_surface
    observed = set()
    for message in zap.core.messages(baseurl=config["origin"], start=0, count=10000):
        first_line = str(message.get("requestHeader", "")).splitlines()[0].split()
        if len(first_line) < 2:
            continue
        method, request_target = first_line[0].upper(), first_line[1]
        parsed = urlparse(request_target)
        path = parsed.path if parsed.scheme else request_target.split("?", 1)[0]
        for route in config["routes"]:
            if method == route["method"] and path == route["seedPath"]:
                observed.add(route["label"])
    expected = {route["label"] for route in config["routes"]}
    if observed != expected:
        raise RuntimeError("ZAP site tree is missing checked-in inventory labels")
    COVERAGE_PATH.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "surface": name,
                "phase": "pre-shutdown-after-active-scan",
                "coveredLabels": sorted(observed),
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    print("DAST-HOOK-PHASE: coverage-complete", flush=True)
