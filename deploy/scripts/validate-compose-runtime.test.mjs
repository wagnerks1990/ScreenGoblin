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
  *" exec -T postgres "*) exit 0 ;;
  *" exec -T minio "*) printf '403'; exit 0 ;;
  *" exec -T api "*) printf 'valid-capability\nexpired-capability\n'; exit 0 ;;
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
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
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
  */health/live) status=204 ;;
  */health/ready) status=404 ;;
  */media/runtime-smoke.txt) status=404 ;;
  *capability=valid-capability) body='ScreenGoblin private media runtime smoke' ;;
  *capability=valid-capabilityx|*capability=expired-capability) status=404 ;;
  *) body='<div id="root"></div>' ;;
esac
printf 'HTTP/2 %s\\r\\nContent-Security-Policy: default-src '\''self'\''\\r\\nX-Frame-Options: DENY\\r\\nStrict-Transport-Security: max-age=31536000\\r\\nX-Content-Type-Options: nosniff\\r\\n\\r\\n' "$status" > "$headers"
if [[ -n "$body" ]]; then printf '%s\\n' "$body" > "$output"; else : > "$output"; fi
printf '%s' "$status"
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "compose-runtime-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const docker = join(bin, "docker");
  const curl = join(bin, "curl");
  writeFileSync(docker, dockerFixture);
  writeFileSync(curl, curlFixture);
  chmodSync(docker, 0o755);
  chmodSync(curl, 0o755);
  return {
    root,
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
    assert.match(scriptSource, /export ACME_EMAIL="ops@smoke\.example\.test"/);
    assert.match(scriptSource, /ACME_EMAIL=\$ACME_EMAIL/);
    assert.match(scriptSource, /MEDIA_DELIVERY_SECRET=\$MEDIA_DELIVERY_SECRET/);
    assert.match(composeSource, /LEGACY_MEDIA_REGISTRATION_ENABLED: "false"/);
    assert.match(scriptSource, /\/media\/runtime-smoke\.txt" 404/);
    assert.match(scriptSource, /Anonymous MinIO object GET returned/);
    assert.match(scriptSource, /private-media-valid/);
    assert.match(scriptSource, /private-media-tampered/);
    assert.match(scriptSource, /private-media-expired/);
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
