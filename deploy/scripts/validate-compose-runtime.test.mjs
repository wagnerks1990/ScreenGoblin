import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./validate-compose-runtime.sh", import.meta.url);
const scriptSource = readFileSync(script, "utf8");
const composeSource = readFileSync(
  new URL("../../docker-compose.yml", import.meta.url),
  "utf8",
);

const dockerFixture = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
case " $* " in
  *" network inspect "*) printf 'true\\n'; exit 0 ;;
  *" config --quiet "*) exit 0 ;;
  *" up --detach "*)
    if [[ "\${FAKE_FAIL_UP:-}" == true ]]; then exit 42; fi
    exit 0
    ;;
  *" down --volumes --remove-orphans "*) exit 0 ;;
  *" ps --all "*) printf 'NAME STATUS\\nsmoke healthy\\n'; exit 0 ;;
  *" ps --quiet "*) printf 'container-%s\\n' "\${!#}"; exit 0 ;;
  *" inspect container-"*)
    if [[ "\${FAKE_HOST_BINDING:-}" == true ]]; then
      printf '[{"HostIp":"0.0.0.0","HostPort":"18080"}]\\n'
    else
      printf 'null\\n'
    fi
    exit 0
    ;;
  *" logs --no-color "*)
    printf 'JWT_SECRET=%s\\n' "$JWT_SECRET"
    printf '%s' "$JWT_SECRET" > "$FAKE_LEAK_CAPTURE"
    exit 0
    ;;
  *" port caddy 80 "*|*" port caddy 443 "*) printf '0.0.0.0:443\\n'; exit 0 ;;
  *" port "*) exit 1 ;;
  *" exec -T postgres "*" -At "*) printf '1\n'; exit 0 ;;
  *" exec -T postgres "*) exit 0 ;;
  *" exec -T minio "*) printf '403'; exit 0 ;;
  *" exec -T api "*"bcrypt"*) printf '\$2b\$12\$fixture'; exit 0 ;;
  *" exec -T api "*"accessToken"*) printf 'fixture-management-token'; exit 0 ;;
  *" exec -T api "*".code"*) printf '123456'; exit 0 ;;
  *" exec -T api "*) printf 'valid-capability\nexpired-capability\n'; exit 0 ;;
  *" run --rm --no-deps --entrypoint node api "*)
    printf 'release-digest\nassignment-digest\nwithdrawal-digest\n'
    exit 0
    ;;
  *" pull zaproxy/zap-stable:"*) exit 0 ;;
  *" image inspect zaproxy/zap-stable:"*) printf '%s\\n' "$COMPOSE_DAST_IMAGE"; exit 0 ;;
  *" zap-full-scan.py "*)
    raw_report=''
    raw_coverage=''
    inventory_path=''
    target=''
    previous=''
    for argument in "$@"; do
      if [[ "$previous" == -t ]]; then target="$argument"; fi
      case "$argument" in
        *,dst=/zap/wrk/report.json) raw_report="\${argument#*src=}"; raw_report="\${raw_report%%,dst=*}" ;;
        *,dst=/zap/wrk/seed-coverage.json) raw_coverage="\${argument#*src=}"; raw_coverage="\${raw_coverage%%,dst=*}" ;;
        *,dst=/zap/runtime-inventory.json,readonly) inventory_path="\${argument#*src=}"; inventory_path="\${inventory_path%%,dst=*}" ;;
      esac
      previous="$argument"
    done
    [[ -n "$raw_report" && -n "$raw_coverage" && -n "$inventory_path" && -n "$target" ]]
    surface=console-api
    [[ "$target" == https://player.example.test ]] && surface=player
    node -e '
      const fs = require("node:fs");
      const [reportPath, coveragePath, inventoryPath, target, surface] = process.argv.slice(1);
      const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
      const alerts = ["10104", "10109"].map((pluginid) => ({
        pluginid,
        alert: "Informational Scanner Observation",
        riskcode: "0",
        riskdesc: "Informational (Medium)",
        confidence: "2",
        confidencedesc: "Medium",
        instances: [],
      }));
      fs.writeFileSync(reportPath, JSON.stringify({ site: [{ "@name": target, alerts }] }));
      fs.writeFileSync(coveragePath, JSON.stringify({
        schemaVersion: 1,
        surface,
        phase: "pre-shutdown-after-active-scan",
        coveredLabels: inventory.surfaces[surface].routes.map((route) => route.label),
      }));
    ' "$raw_report" "$raw_coverage" "$inventory_path" "$target" "$surface"
    printf 'INFO: 2 WARN-NEW: 2\\n'
    exit "\${FAKE_ZAP_STATUS:-0}"
    ;;
  *" run --rm "*) exit 0 ;;
esac
echo "Unexpected fake docker command: $*" >&2
exit 99
`;

const curlFixture = `#!/usr/bin/env bash
set -eu
output=''
headers=''
url=''
request='GET'
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    --request) request="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "\${FAKE_FAIL_CURL:-}" == true ]]; then
  echo 'synthetic probe failure' >&2
  exit 22
fi
status=200
body=''
case "$url" in
  */api/v1/auth/login)
    if [[ "$request" == TRACE ]]; then status=405; body=''; fi
    if [[ "$request" == POST ]]; then status=400; body='{"error":"invalid request"}'; fi
    ;;
  */api/v1/pairing-codes) status=410; body='{"error":{"code":"UNTARGETED_ENROLLMENT_REMOVED"}}' ;;
  */api/v1/screens/compose-enrollment-screen/device-enrollment)
    status=201; body='{"grantId":"fixture-grant","screenId":"compose-enrollment-screen","code":"123456","expiresAt":"2099-01-01T00:00:00Z","generation":0}'
    ;;
  */health/live) status=204 ;;
  */health/ready) status=404 ;;
  */media/runtime-smoke.txt) status=404 ;;
  *capability=valid-capability) body='ScreenGoblin private media runtime smoke' ;;
  *capability=valid-capabilityx|*capability=expired-capability) status=404 ;;
  *) body='<div id="root"></div>' ;;
esac
if [[ "$output" == *enrollment-login.json ]]; then status=200; body='{"accessToken":"fixture-management-token"}'; fi
if [[ "$output" == *private-media-withdrawn.body ]]; then status=404; body=''; fi
csp="default-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'none'"
if [[ "$url" == https://player.example.test/* ]]; then
  csp="default-src 'self'; style-src 'self'; connect-src 'self' https://signage.example.test; frame-src 'none'"
fi
if [[ -n "\${FAKE_CSP:-}" ]]; then csp="$FAKE_CSP"; fi
if [[ -n "$headers" ]]; then
  printf 'HTTP/2 %s\\r\\nContent-Security-Policy: %s\\r\\nX-Frame-Options: DENY\\r\\nStrict-Transport-Security: max-age=31536000\\r\\nX-Content-Type-Options: nosniff\\r\\n\\r\\n' "$status" "$csp" > "$headers"
fi
if [[ -n "$output" ]]; then
  if [[ -n "$body" ]]; then printf '%s\\n' "$body" > "$output"; else : > "$output"; fi
fi
printf '%s' "$status"
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "compose-runtime-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const docker = join(bin, "docker");
  const curl = join(bin, "curl");
  const id = join(bin, "id");
  writeFileSync(docker, dockerFixture);
  writeFileSync(curl, curlFixture);
  writeFileSync(
    id,
    '#!/usr/bin/env bash\ncase "$1" in -u) echo 1000 ;; -g) echo 1000 ;; *) exit 2 ;; esac\n',
  );
  chmodSync(docker, 0o755);
  chmodSync(curl, 0o755);
  chmodSync(id, 0o755);
  return {
    root,
    bin,
    docker,
    curl,
    evidence: join(root, "evidence"),
    commandLog: join(root, "commands.log"),
    leakCapture: join(root, "leak.txt"),
  };
}

function runSmoke(f, extraEnv = {}) {
  return spawnSync("bash", [script.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_BIN: f.docker,
      CURL_BIN: f.curl,
      COMPOSE_SMOKE_PROJECT: "screengoblin-smoke-test",
      COMPOSE_SMOKE_TIMEOUT_SECONDS: "180",
      COMPOSE_SMOKE_EVIDENCE_DIR: f.evidence,
      FAKE_COMMAND_LOG: f.commandLog,
      FAKE_LEAK_CAPTURE: f.leakCapture,
      PATH: `${f.bin}:${process.env.PATH}`,
      ...extraEnv,
    },
  });
}

test("runs bounded production-mode probes and always removes volumes", () => {
  const f = fixture();
  try {
    const result = runSmoke(f);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /production-runtime smoke passed/);
    assert.match(scriptSource, /UNTARGETED_ENROLLMENT_REMOVED|expected 410/);
    assert.match(scriptSource, /device-enrollment/);
    assert.match(scriptSource, /authorizedByAuthenticationEpoch/);
    assert.match(scriptSource, /authorizedByAuthorizationEpoch/);
    assert.match(scriptSource, /export ACME_EMAIL="ops@smoke\.example\.test"/);
    assert.match(scriptSource, /ACME_EMAIL=\$ACME_EMAIL/);
    assert.match(scriptSource, /MEDIA_DELIVERY_SECRET=\$MEDIA_DELIVERY_SECRET/);
    assert.match(composeSource, /LEGACY_MEDIA_REGISTRATION_ENABLED: "false"/);
    assert.match(scriptSource, /\/media\/runtime-smoke\.txt" 404/);
    assert.match(scriptSource, /Anonymous MinIO object GET returned/);
    assert.match(scriptSource, /private-media-valid/);
    assert.match(scriptSource, /private-media-withdrawn/);
    assert.match(scriptSource, /private-media-tampered/);
    assert.match(scriptSource, /private-media-expired/);
    assert.match(scriptSource, /releaseSnapshotDigest/);
    assert.match(scriptSource, /canonicalAssignmentSnapshot/);
    assert.doesNotMatch(scriptSource, /repeat\('[abc]', 64\)/);
    const commands = readFileSync(f.commandLog, "utf8");
    assert.match(commands, /up --detach --wait --wait-timeout 180/);
    assert.match(commands, /network inspect screengoblin-smoke-test_backend/);
    assert.match(commands, /ps --quiet console/);
    assert.match(commands, /inspect container-console/);
    assert.match(commands, /run --rm --no-deps --entrypoint/);
    assert.match(commands, /exec -T postgres psql/);
    assert.match(commands, /exec -T minio curl/);
    assert.match(commands, /exec -T api node/);
    assert.match(commands, /down --volumes --remove-orphans --timeout 20/);
    assert.match(
      readFileSync(join(f.evidence, "result.txt"), "utf8"),
      /startup and health: passed/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("validated informational ZAP evidence is authoritative over wrapper finding status", () => {
  const f = fixture();
  try {
    const result = runSmoke(f, {
      COMPOSE_DAST_IMAGE:
        "zaproxy/zap-stable:2.17.0@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2",
      FAKE_ZAP_STATUS: "2",
    });
    assert.equal(result.status, 0, result.stderr);
    for (const surface of ["console-api", "player"]) {
      const evidence = JSON.parse(
        readFileSync(join(f.evidence, `zap-${surface}.json`), "utf8"),
      );
      assert.equal(evidence.findingCount, 2);
      assert.equal(evidence.informationalFindingCount, 2);
      assert.equal(evidence.securitySeverityFindingCount, 0);
    }
    assert.match(
      result.stderr,
      /validated retained report severity is authoritative/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("ZAP operational wrapper failure remains blocking even with a report", () => {
  const f = fixture();
  try {
    const result = runSmoke(f, {
      COMPOSE_DAST_IMAGE:
        "zaproxy/zap-stable:2.17.0@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2",
      FAKE_ZAP_STATUS: "3",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scanner failed operationally.*exit 3/);
    assert.match(
      readFileSync(f.commandLog, "utf8"),
      /down --volumes --remove-orphans --timeout 20/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("propagates failures, redacts diagnostics, and still cleans up", () => {
  const f = fixture();
  try {
    const result = runSmoke(f, { FAKE_FAIL_CURL: "true" });
    assert.notEqual(result.status, 0);
    const leakedSecret = readFileSync(f.leakCapture, "utf8");
    const diagnostics = readFileSync(
      join(f.evidence, "compose-logs.txt"),
      "utf8",
    );
    assert.ok(!diagnostics.includes(leakedSecret));
    assert.match(diagnostics, /JWT_SECRET=\[REDACTED\]/);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(leakedSecret));
    assert.match(result.stderr, /sanitized Compose diagnostics/);
    assert.match(result.stderr, /JWT_SECRET=\[REDACTED\]/);
    assert.match(
      readFileSync(f.commandLog, "utf8"),
      /down --volumes --remove-orphans --timeout 20/,
    );
    assert.match(
      readFileSync(join(f.evidence, "result.txt"), "utf8"),
      /failed \(exit /,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const [name, csp] of [
  [
    "wildcard origin",
    "default-src 'self'; style-src 'self'; connect-src 'self' https://example.test:*; frame-src 'none'",
  ],
  [
    "scheme-wide source",
    "default-src 'self'; style-src 'self'; connect-src 'self' https:; frame-src 'none'",
  ],
  [
    "insecure origin",
    "default-src 'self'; style-src 'self'; connect-src 'self' http://example.test; frame-src 'none'",
  ],
]) {
  test(`rejects a CSP ${name}`, () => {
    const f = fixture();
    try {
      const result = runSmoke(f, { FAKE_CSP: csp });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /wildcard or scheme-wide source/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("rejects unsafe inline styles in CSP", () => {
  const f = fixture();
  try {
    const result = runSmoke(f, {
      FAKE_CSP:
        "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restrict styles to packaged resources/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("bounds startup failure and invokes cleanup", () => {
  const f = fixture();
  try {
    const result = runSmoke(f, { FAKE_FAIL_UP: "true" });
    assert.equal(result.status, 42);
    const commands = readFileSync(f.commandLog, "utf8");
    assert.match(commands, /up --detach --wait --wait-timeout 180/);
    assert.match(commands, /down --volumes --remove-orphans --timeout 20/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects a real private-service host binding and invokes cleanup", () => {
  const f = fixture();
  try {
    const result = runSmoke(f, { FAKE_HOST_BINDING: "true" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpectedly has host bindings/);
    assert.match(
      readFileSync(f.commandLog, "utf8"),
      /down --volumes --remove-orphans --timeout 20/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
