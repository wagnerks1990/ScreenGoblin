# Release evidence

ScreenGoblin CI builds the final API, Console, and web-player container stages and records evidence about those exact local images. Evidence does not turn a commit into an approved production release.

## Pull-request and scheduled scanning

`.github/workflows/codeql.yml` runs GitHub CodeQL's `security-extended` suite
for JavaScript/TypeScript, the native Java Player sources, and GitHub Actions on
pull requests, `main`, a weekly schedule, and manual dispatch. The action is
commit-pinned. GitHub Code Scanning default setup already owns repository alert
uploads, so this workflow writes per-language SARIF evidence and fails on any
first-party finding instead of attempting a conflicting advanced-setup upload.
Java analysis traces a real debug compilation after regenerating the Capacitor
Android project. Findings in installed or generated dependency sources remain in
the retained SARIF but do not block this repository's gate and require explicit
review or upstream remediation. Dependency review separately blocks newly
introduced dependencies with known moderate-or-higher vulnerabilities.

The Java gate contains one hash-bound false-positive acceptance for
`java/improper-intent-verification` on `BootReceiver`. The receiver is explicitly
non-exported and null-safely rejects every action except `BOOT_COMPLETED`, matching
the query's recommendation. The exception activates only while both that source
file and its manifest declaration retain their reviewed SHA-256 values; a change
to either makes the alert blocking again. The full result remains in SARIF.

`.github/workflows/container-scan.yml` performs blocking repository vulnerability, secret, infrastructure/configuration misconfiguration, exact lockfile-license policy, and final-image vulnerability checks. The repository job uses the same checksum-verified Trivy binary for independent vulnerability, secret, configuration, and license-inventory passes. A repository-owned validator rejects unapproved or unidentified lockfile licenses and fails closed on broad, stale, malformed, or unused exceptions.

Successful repository scans retain secret, misconfiguration, and vulnerability SARIF plus deterministic, sanitized dependency-license evidence under an exact commit-named artifact. `SHA256SUMS` binds every retained file. The license evidence contains dependency names, versions, exact license expressions, provenance classifications, and input-policy digests, but omits registry/file/git locators and integrity material. Secret SARIF and the artifact are uploaded only after all blocking scans succeed, avoiding retention of an actual detected secret. See `security/README.md` for the exact, time-bounded exception process.

The image job also emits CycloneDX SBOMs, Trivy SARIF, Docker image inspection records, image IDs, source commit/tree/archive digests, Dockerfile digests, and SHA-256 checksums. SARIF is uploaded to GitHub code scanning and the remaining evidence is retained as a short-lived workflow artifact. The builder refuses a dirty worktree or a requested evidence ID that differs from the checked-out commit.

These are static repository and build-input controls only. They do not perform DAST, inspect a deployed target, continuously monitor production, or establish production runtime configuration.

CI also runs four single-worker Chromium scenarios against the compiled Console,
compiled API, and a dedicated migrated PostgreSQL database. The gate exercises
real owner authentication, live screen creation and display, pairing-code
creation, explicit disconnect, 401 session invalidation without demo fallback,
WCAG 2.1 A/AA axe scans over five representative states, skip navigation, and
Modal/Drawer focus containment and restoration. Browser traces, screenshots,
videos, HTML reports, and reusable authenticated storage state are disabled to
avoid retaining test JWTs or pairing codes. Playwright and axe packages are
exact-lockfile pinned; the hosted runner packages installed by Playwright remain
a CI supply-chain limitation and are not release provenance.

The container CI job also starts the complete production-mode Compose topology
under a unique project name with runtime-generated secrets and Caddy local test
TLS. It waits a bounded interval for health, exercises API, readiness isolation,
Console, Player, browser response headers, and a disposable MinIO object through
Caddy, and confirms that only Caddy publishes host ports while the backend
network remains internal. Failure diagnostics are secret-redacted, retained for
seven days, and the cleanup trap removes the disposable volumes on every exit.
This runner smoke is integration evidence, not proof of production DNS, public
TLS, firewall rules, capacity, backup quality, or device behavior.

When `COMPOSE_DAST_IMAGE` is set by CI, the same disposable stack gains an
internal scan network attached only to Caddy. The workflow pulls ZAP 2.17.0 by
its reviewed multi-platform SHA-256 manifest digest, verifies the resolved
digest, then runs the image with no capabilities, no-new-privileges, a read-only
root filesystem, bounded memory/CPU/PIDs/time, and no external network route.
Blocking active scans cover the unauthenticated Console/API and Player public
origins. A checked-in method/template inventory is compared to Fastify's real
route registration, excluding only automatic HEAD/OPTIONS and the Caddy-denied
readiness endpoint. A scan hook sends every inventory seed through ZAP before
the recursive active scan and verifies that all fixed labels remain in ZAP's
site tree after it completes. Separate probes reject enabled TRACE behavior, hostile-origin CORS
reflection, internal markers in malformed-login errors, and executable payload
reflection. Scanner failures and every Low, Medium, or High report alert block
the job. The packaged wrapper has a fixed internal ignored-rule set, so its
status alone is not authoritative: the sanitizer independently classifies the
complete JSON report from strict numeric risk/confidence fields. Every alert,
including Informational observations and wrapper-excluded IDs, remains retained
and counted; no rule-ID suppression is applied. Wrapper finding statuses 1 and
2 are accepted only after the complete report and post-scan coverage validate
and the sanitizer finds no security-severity alert. Operational status 3,
timeouts, signals, unexpected statuses, and malformed evidence always block.
Runtime assertions also require host-specific CSP: Console connections
remain same-origin, Player may connect only to its own origin and the exact
configured ScreenGoblin API origin, and neither public surface permits
scheme-wide, wildcard, localhost-port, inline-style, or frame sources. Private
media uses that same API origin and blob/data rendering remains explicitly
bounded.

ZAP work/state is hard-limited to a 256 MiB, mode-0700 tmpfs owned by the
non-root runner identity; individual output files also have a 256 MiB limit.
Only the raw report and fixed-label coverage file are bind-mounted separately,
each under that inherited 256 MiB file limit, so they survive long enough for
validation before the disposable work directory is removed. Retained JSON
maps the pinned traditional-report schema's numeric risk and confidence codes
to fixed labels and contains only rule identity, risk/confidence, method,
strictly validated parameter and route labels, and SHA-256 digests for unknown
paths. Unsafe alert names are SHA-256 digested and unsafe parameter names are
replaced with a fixed marker. It omits raw URI paths, response evidence, attack strings,
response bodies, hostnames, URL credentials, query values, fragments, and
capabilities. A sorted `SHA256SUMS` binds the
sanitized scan summaries and Compose evidence and is verified before upload.
This is narrow runner DAST, not production monitoring or a penetration test. It
does not authenticate, exercise authorization/tenant boundaries, scan
capability-authorized private media, validate production DNS/TLS/firewalls,
execute a browser DOM scanner, or cover operator/device/hardware workflows.

The Compose gate separately proves query-free header-authorized private-media
delivery and opaque rejection of query, missing, duplicate, Bearer, tampered,
expired, and withdrawn credentials. Evidence and logs must never include the
derived capability value; any external ingress requires verified Authorization
redaction before deployment.

Gradle verifies the pinned 8.11.1 distribution ZIP against the checksum
published for that exact distribution. The Android build also uses strict
SHA-256 verification metadata for Maven, plugin, module-metadata, and transitive
artifacts resolved by its lint, unit-test, debug-assembly, and CodeQL compile
paths, including release assembly. `npm run validate:gradle-integrity` fails if that metadata or its strict
configuration is removed, malformed, broadly exempted, or bypassed. These
checksums pin reviewed bytes; they are not independent proof of publisher
identity or provenance.

Strict Gradle dependency locks also pin the selected buildscript, app, generated
Cordova bridge, and Capacitor Android transitive graphs. Because Capacitor is
regenerated under `node_modules`, its lock state is deliberately redirected to
a unique checked-in path under `apps/player/android/gradle/dependency-locks`.
The build uses Android Gradle Plugin 8.10.1 and Google Services plugin 4.5.0
with explicit scanner-fixed
resolution pins for Netty 4.1.137.Final, Protobuf 3.25.5, Bouncy Castle 1.84,
jose4j 0.9.6, and JDOM 2.0.6.1 across root, regenerated-project buildscript,
and Android test-platform configurations.
Lock updates must be explicit, reviewed together with verification-metadata
changes, and exercised through the complete Android CI task graph.

The Android release-surface validator invokes SDK `apkanalyzer manifest print`
itself on the assembled release APK and validates that packaged output against
an exact policy. The package must be `com.screengoblin.player` with minimum SDK
23 and target SDK 35. It uses `INTERNET`, `RECEIVE_BOOT_COMPLETED`, and the exact
package-derived `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which the manifest
also declares with signature protection. Leanback and touchscreen are the exact
optional features. Backup and cleartext traffic are explicitly disabled, while
debuggable, test-only, and legacy external storage are absent or false. Shared
user IDs, package queries, instrumentation, uses-library declarations, network
security overrides, activity aliases, and services are forbidden.

The sole exported component is `MainActivity` with exactly the MAIN, LAUNCHER,
and LEANBACK_LAUNCHER intent surface. The enabled `BootReceiver` is non-exported
and restricted to `BOOT_COMPLETED`. The only provider is the non-exported
`androidx.startup.InitializationProvider` under the package-derived authority;
it contains exactly the ProcessLifecycle and EmojiCompat initializers. Source
manifest merge rules remove the ProfileInstaller initializer and receiver plus
its DUMP permission, and the final packaged policy rejects their return.

The validator emits a schema-versioned JSON summary containing the package and
SDK values, sorted permissions and features, exported and non-exported
component lists, SHA-256 of the textual packaged manifest, and SHA-256 of the
exact unsigned APK from which it was extracted. It also records the analyzer
version returned by the same executable that performed extraction.
CI retains that summary, the extracted manifest, and the unsigned release APK
for seven days as `player-release-surface-<commit>`. The artifact is temporary
engineering evidence and must not be distributed or represented as a signed
release.

If validation fails after manifest extraction, CI retains only that manifest
for one day as `player-release-surface-diagnostic-<commit>`. This deliberately
short-lived failure diagnostic is not a successful policy report and must not
be treated as release evidence.

This is static evidence about one assembled APK's declared manifest surface. It
does not sign the APK, retain a production signing certificate, establish
artifact provenance or reproducibility, scan runtime behavior, constitute an
OWASP MASVS assessment, or replace installation and behavior tests on
representative managed hardware.

Docker build stages, Compose services, CI services, and recovery fixtures retain readable tags but resolve only through
checked-in multi-platform SHA-256 digests. Builds do not perform floating OS
package upgrades; base refreshes require a reviewed digest change and must pass
the blocking image scan. `npm run validate:container-inputs` rejects new mutable
Dockerfile `FROM` references, Compose/workflow image declarations,
`docker://` actions, recovery defaults, or Dockerfile package upgrades.

Recovery image overrides are accepted only when the operator supplies an
explicit SHA-256 digest; the drill records the resolved references in its
evidence bundle.

The recovery workflow builds the API migration stage and applies the complete
checked-in Prisma migration chain to an empty disposable PostgreSQL database.
It then backs up and restores a representative organization, user, membership,
epoch-bound user session, screen, playlist/media, schedule/target, immutable
release/assignment, and audit relation graph. The registered live and frozen media metadata is bound to
the exact size and SHA-256 of an object that is independently mirrored, deleted,
restored, and byte-compared in disposable MinIO. After restore, the drill checks
the applied migration count, validated constraints, composite references, audit
link, restored local audit-shape function and mutation trigger, rejection of an
ordinary audit update, and both copies of the referenced object metadata. The
audit check is recovery evidence for a database-owner-bypassable local
guardrail, not evidence of WORM storage, tamper detection, export delivery,
retention, or legal holds.

The retained artifact includes fixture image digests, checksums, source commit,
schema/reference results, dump and object hashes/sizes, and elapsed migration,
dump, restore, object recovery, and image rollback timings. These measurements
describe one hosted disposable CI run only. They are not production RPO or RTO
evidence and do not exercise production data volume, write quiescence,
encryption or off-host transfer, retention, regional loss, credential recovery,
operator response, or a production restore destination.

`--ignore-unfixed` is intentional: findings without an upstream fix remain visible in reports but do not independently block this prototype workflow. This policy must be reviewed before production approval. An exception must never be created merely to obtain a green build.

## Tag and manual evidence

`.github/workflows/release-evidence.yml` runs for `v*` tags and manual
dispatches. The build job gives neither trigger OIDC or attestation authority. It
packages the checksum-bound evidence directory into a gzip archive with stable
entry ordering, timestamps, ownership, modes, and gzip headers, then verifies
the archive's adjacent SHA-256 checksum. This normalizes packaging metadata; it
does not claim that independent container builds are byte-for-byte reproducible.

For a `v*` tag event, a separate tag-only job receives
`id-token: write` and `attestations: write`. The build job passes it only the
archive and checksum through a one-day handoff artifact. The tag job rechecks
the checksum, creates GitHub OIDC build provenance for the archive digest,
immediately verifies that attestation against this repository, and only then
retains the final **attested release evidence** artifact for 30 days. The
archive's internal `SHA256SUMS` transitively binds its Docker archives, SBOMs,
scan results, image inspection records, and source metadata to the attested
subject.

A manual dispatch never runs the privileged provenance job. It retains the same
archive and checksum for 30 days under the explicit **unsigned release
evidence** name, even when Docker archives were requested.

This tranche does not provide:

- a trusted production registry or digest-pinned promotion contract;
- independent or hardware-backed production artifact signing and key custody;
- direct OCI-image or Android APK signatures/provenance;
- protected production-environment approval; or
- Android production signing and controlled rollout evidence.

Until those controls and the remaining pre-production gates are implemented and
evidenced, neither artifact may be described or used as a production release.

## Local reproduction

Install the pinned Trivy version documented in the workflows, then run:

```bash
RELEASE_EVIDENCE_DIR=release-evidence \
RELEASE_EVIDENCE_ID="$(git rev-parse HEAD)" \
RELEASE_EVIDENCE_ARCHIVES=false \
deploy/scripts/build-release-evidence.sh
```

The builder refuses to overwrite an existing evidence directory. To reproduce
the workflow's canonical packaging, run
`deploy/scripts/package-release-evidence.sh release-evidence release-evidence.tar.gz`;
the packager also refuses archive/checksum collisions. Set
`RELEASE_EVIDENCE_ARCHIVES=true` only when local Docker archives are required
and protected storage capacity is available. Local packaging remains unsigned
unless a trusted external system attests the resulting archive digest.

## Promotion requirements

Before a production promotion exists, define and test registry immutability, signing identity and custody, provenance verification, release approvals, rollback retention, vulnerability exception ownership and expiry, APK signing, and deployment verification. Record the exact source commit, image digests, migration compatibility, approvers, recovery evidence, and pilot-device results in the release record.
