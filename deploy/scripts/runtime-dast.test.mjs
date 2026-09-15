import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const summarizer = new URL("./summarize-zap-report.mjs", import.meta.url);
const inventoryPath = new URL("./zap-runtime-inventory.json", import.meta.url);
const summarizerSource = readFileSync(summarizer, "utf8");
const hook = readFileSync(
  new URL("./zap-runtime-hooks.py", import.meta.url),
  "utf8",
);
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const workflow = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("./validate-compose-runtime.sh", import.meta.url),
  "utf8",
);
const caddyConfig = readFileSync(
  new URL("../caddy/Caddyfile", import.meta.url),
  "utf8",
);
const spaConfig = readFileSync(
  new URL("../nginx/spa.conf", import.meta.url),
  "utf8",
);
const pinnedImage =
  "zaproxy/zap-stable:2.17.0@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2";

test("runtime DAST remains pinned, isolated, blocking, and checksum-bound", () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(
    workflow,
    new RegExp(
      `COMPOSE_DAST_IMAGE: ${pinnedImage.replace(
        /[.*+?^$\{\}()|[\]\\]/g,
        "\\$&",
      )}`,
    ),
  );
  assert.match(runtime, /--network "\$\{project_name\}_dast"/);
  assert.match(runtime, /scanner_uid="\$\(id -u\)"/);
  assert.match(runtime, /\(\(scanner_uid > 0\)\)/);
  assert.match(runtime, /--user "\$scanner_uid:\$scanner_gid"/);
  assert.doesNotMatch(runtime, /--user 0(?::0)?/);
  assert.match(runtime, /--workdir \/zap\/wrk/);
  assert.match(runtime, /--env HOME=\/zap\/wrk/);
  assert.match(runtime, /--env XDG_CACHE_HOME=\/zap\/wrk\/\.cache/);
  assert.match(runtime, /--read-only/);
  assert.match(runtime, /--tmpfs "\/zap\/wrk:[^"]*size=\$\{DAST_TMPFS_BYTES\}/);
  assert.match(runtime, /ulimit -f "\$DAST_FILE_BLOCKS"/);
  assert.match(
    runtime,
    /--ulimit "fsize=\$DAST_TMPFS_BYTES:\$DAST_TMPFS_BYTES"/,
  );
  assert.match(runtime, /--cap-drop ALL/);
  assert.match(runtime, /no-new-privileges/);
  assert.match(runtime, /--pull never/);
  assert.match(
    runtime,
    /zap-full-scan\.py -t "\$target" -m 1 -T 8 \\\n\s+-J report\.json -s --hook=\/zap\/runtime-hooks\.py/,
  );
  assert.match(runtime, /src=\$raw_report,dst=\/zap\/wrk\/report\.json/);
  assert.match(
    runtime,
    /src=\$raw_coverage,dst=\/zap\/wrk\/seed-coverage\.json/,
  );
  assert.doesNotMatch(runtime, /tail[^\n]*scan_log/);
  assert.match(runtime, /if \[\[ "\$dast_active" == false \]\]; then/);
  assert.doesNotMatch(runtime, /--auto(?:off)?/);
  assert.doesNotMatch(runtime, /(?:^|\s)-I(?:\s|$)/m);
  assert.doesNotMatch(runtime, /\bIGNORE\b/);
  assert.match(runtime, /case "\$scan_status" in[\s\S]*0 \| 1 \| 2\)/);
  assert.match(runtime, /scanner failed operationally/);
  assert.match(
    runtime,
    /if \(\(summary_status != 0\)\)[\s\S]*return "\$summary_status"/,
  );
  assert.doesNotMatch(runtime, /return "\$scan_status"/);
  assert.match(
    summarizerSource,
    /if \(evidence\.securitySeverityFindingCount > 0\)[\s\S]*process\.exitCode = 2/,
  );
  assert.match(hook, /def zap_started\(zap, target\):/);
  assert.match(hook, /zap\.core\.send_request/);
  assert.doesNotMatch(hook, /send_request[\s\S]{0,200}responseHeader/);
  assert.match(hook, /DAST-HOOK-PHASE: seed-complete/);
  assert.match(hook, /def zap_pre_shutdown\(zap\):/);
  assert.match(hook, /zap\.core\.messages/);
  assert.match(hook, /DAST-HOOK-PHASE: coverage-complete/);
  assert.match(runtime, /ERROR <class/);
  assert.match(runtime, /grep -Eo/);
  assert.doesNotMatch(runtime, /"\$scan_log" \| LC_ALL/);
  assert.equal(inventory.surfaces["console-api"].routes.length, 43);
  assert.equal(inventory.surfaces.player.routes.length, 1);
  assert.match(runtime, /TRACE/);
  assert.match(runtime, /malformed-auth/);
  assert.match(runtime, /SHA256SUMS/);
  assert.match(runtime, /sha256sum --check SHA256SUMS/);
  assert.doesNotMatch(spaConfig, /Content-Security-Policy/);
  assert.match(caddyConfig, /connect-src 'self'; frame-src 'none'/);
  assert.match(caddyConfig, /style-src 'self';/);
  assert.doesNotMatch(caddyConfig, /unsafe-inline/);
  assert.match(
    caddyConfig,
    /connect-src 'self' https:\/\/\{\$SCREEN_GOBLIN_HOST:localhost\}; frame-src 'none'/,
  );
  assert.doesNotMatch(caddyConfig, /(?:^|[ ;])https:(?:[ ;]|$)|http:|:\*/m);
  assert.match(runtime, /assert_csp "console"/);
  assert.match(runtime, /assert_csp "player" "https:\/\/\$SCREEN_GOBLIN_HOST"/);
  assert.match(
    workflow,
    /always\(\) && hashFiles\('compose-smoke-evidence\/\*\*'\) != ''/,
  );
});

function writeCoverage(root, surface = "console-api", labels) {
  const coverage = join(root, "coverage.json");
  writeFileSync(
    coverage,
    JSON.stringify({
      schemaVersion: 1,
      surface,
      phase: "pre-shutdown-after-active-scan",
      coveredLabels:
        labels ??
        inventory.surfaces[surface].routes.map((route) => route.label),
    }),
  );
  return coverage;
}

function summaryArgs(input, output, coverage, surface = "console-api") {
  return [
    summarizer.pathname,
    input,
    output,
    surface,
    pinnedImage,
    inventory.surfaces[surface].origin,
    coverage,
    inventoryPath.pathname,
  ];
}

test("ZAP evidence is deterministic and excludes raw evidence and hostnames", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-summary-test-"));
  try {
    const input = join(root, "raw.json");
    const output = join(root, "summary.json");
    writeFileSync(
      input,
      JSON.stringify({
        site: [
          {
            "@name": "https://signage.example.test",
            "@host": "signage.example.test",
            alerts: [
              {
                pluginid: "40018",
                alert: "SQL Injection\nprivate-alert-capability",
                riskcode: "3",
                confidence: "2",
                riskdesc: "High (Medium)",
                confidencedesc: "Medium",
                evidence: "sensitive response fragment",
                instances: [
                  {
                    uri: "https://user:password@signage.example.test/api/v1/screens/credential-capability?q=credential-value#secret-fragment",
                    method: "get",
                    param: "q",
                    attack: "' OR 1=1",
                  },
                  {
                    uri: "https://signage.example.test/attack/private-capability-value/%3Cscript%3E?capability=private-capability-value#private-fragment",
                    method: "post",
                    param: "hostile\nparameter=value",
                    attack: "<script>attack-value</script>",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      summaryArgs(input, output, writeCoverage(root)),
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2, result.stderr);
    const first = readFileSync(output, "utf8");
    const evidence = JSON.parse(first);
    assert.equal(evidence.findingCount, 1);
    assert.equal(evidence.securitySeverityFindingCount, 1);
    assert.equal(evidence.informationalFindingCount, 0);
    assert.equal(evidence.findings[0].risk, "High");
    assert.equal(evidence.findings[0].confidence, "Medium");
    assert.match(evidence.findings[0].name, /^name-sha256:[0-9a-f]{64}$/);
    assert.deepEqual(evidence.findings[0].locations[0], {
      method: "GET",
      route: "screens-item",
      parameter: "q",
    });
    assert.equal(evidence.findings[0].locations[1].method, "POST");
    assert.match(
      evidence.findings[0].locations[1].route,
      /^path-sha256:[0-9a-f]{64}$/,
    );
    assert.equal(
      evidence.findings[0].locations[1].parameter,
      "[redacted-unsafe-name]",
    );
    assert.ok(!first.includes("sensitive response fragment"));
    assert.ok(!first.includes("signage.example.test"));
    assert.ok(!first.includes("OR 1=1"));
    assert.ok(!first.includes("user:password"));
    assert.ok(!first.includes("credential-value"));
    assert.ok(!first.includes("secret-fragment"));
    assert.ok(!first.includes("private-capability-value"));
    assert.ok(!first.includes("private-fragment"));
    assert.ok(!first.includes("/api/v1/screens/credential-capability"));
    assert.ok(!first.includes("/attack/"));
    assert.ok(!first.includes("hostile"));
    assert.ok(!first.includes("attack-value"));
    assert.ok(!first.includes("private-alert-capability"));

    const second = join(root, "summary-2.json");
    const rerun = spawnSync(
      process.execPath,
      summaryArgs(input, second, writeCoverage(root)),
      { encoding: "utf8" },
    );
    assert.equal(rerun.status, 2, rerun.stderr);
    assert.equal(readFileSync(second, "utf8"), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ZAP informational alerts, including packaged-wrapper ignored rules, are retained without blocking", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-summary-wrapper-ignore-"));
  try {
    const input = join(root, "raw.json");
    const output = join(root, "summary.json");
    writeFileSync(
      input,
      JSON.stringify({
        site: [
          {
            "@name": "https://signage.example.test",
            alerts: ["50003", "60000", "10104", "10109"].map((pluginid) => ({
              pluginid,
              alert: "Packaged Wrapper Ignored Rule",
              riskcode: "0",
              riskdesc: "Informational (Low)",
              confidence: "1",
              confidencedesc: "Low",
              instances: [],
            })),
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      summaryArgs(input, output, writeCoverage(root)),
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(evidence.findingCount, 4);
    assert.equal(evidence.informationalFindingCount, 4);
    assert.equal(evidence.securitySeverityFindingCount, 0);
    assert.deepEqual(
      evidence.findings.map((finding) => finding.ruleId),
      ["10104", "10109", "50003", "60000"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ZAP evidence fails closed on incomplete report structure", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-summary-invalid-"));
  try {
    const input = join(root, "raw.json");
    writeFileSync(
      input,
      JSON.stringify({
        site: [{ "@name": "https://signage.example.test", alerts: [{}] }],
      }),
    );
    const result = spawnSync(
      process.execPath,
      summaryArgs(input, join(root, "summary.json"), writeCoverage(root)),
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete alert identity metadata/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ZAP evidence rejects contradictory numeric risk metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-summary-risk-schema-"));
  const sentinel = "private-risk-description-capability";
  try {
    const input = join(root, "raw.json");
    const output = join(root, "summary.json");
    writeFileSync(
      input,
      JSON.stringify({
        site: [
          {
            "@name": "https://signage.example.test",
            alerts: [
              {
                pluginid: "40018",
                alert: "SQL Injection",
                riskcode: "3",
                confidence: "2",
                riskdesc: `Low (${sentinel})`,
                confidencedesc: "Medium",
                instances: [],
              },
            ],
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      summaryArgs(input, output, writeCoverage(root)),
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incomplete alert identity metadata/);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(sentinel));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ZAP evidence parse failures never echo untrusted report values", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-summary-parse-safety-"));
  const sentinel =
    "private-capability-path?secret-query=credential-value#secret-fragment";
  try {
    for (const [name, contents, expected] of [
      [
        "invalid-uri",
        JSON.stringify({
          site: [
            {
              "@name": "https://signage.example.test",
              alerts: [
                {
                  pluginid: "40018",
                  alert: "SQL Injection",
                  riskcode: "3",
                  riskdesc: "High (Medium)",
                  confidence: "2",
                  confidencedesc: "Medium",
                  instances: [{ uri: `http://[${sentinel}`, method: "GET" }],
                },
              ],
            },
          ],
        }),
        /invalid location/,
      ],
      ["invalid-json", `{\"site\":[\"${sentinel}`, /not valid JSON/],
    ]) {
      const input = join(root, `${name}.json`);
      const output = join(root, `${name}-summary.json`);
      writeFileSync(input, contents);
      const result = spawnSync(
        process.execPath,
        summaryArgs(input, output, writeCoverage(root)),
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      let retained = "";
      try {
        retained = readFileSync(output, "utf8");
      } catch {
        // No output is the expected fail-closed behavior before validation.
      }
      assert.ok(
        !`${result.stdout}\n${result.stderr}\n${retained}`.includes(sentinel),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ZAP evidence rejects empty, wrong-origin, and incomplete coverage reports", () => {
  const root = mkdtempSync(join(tmpdir(), "zap-summary-scope-"));
  try {
    const output = join(root, "summary.json");
    for (const [name, report, labels, expected] of [
      ["empty", { site: [] }, undefined, /empty or missing site inventory/],
      [
        "wrong-origin",
        { site: [{ "@name": "https://wrong.example.test", alerts: [] }] },
        undefined,
        /does not match the expected target origin/,
      ],
      [
        "missing-coverage",
        { site: [{ "@name": "https://signage.example.test", alerts: [] }] },
        ["console-root"],
        /seed coverage is incomplete/,
      ],
    ]) {
      const input = join(root, `${name}.json`);
      writeFileSync(input, JSON.stringify(report));
      const result = spawnSync(
        process.execPath,
        summaryArgs(input, output, writeCoverage(root, "console-api", labels)),
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
