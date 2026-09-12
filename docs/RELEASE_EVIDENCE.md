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

`.github/workflows/container-scan.yml` performs two blocking checks:

- repository filesystem scanning for unresolved `HIGH` and `CRITICAL` findings; and
- final-image builds followed by unresolved `HIGH` and `CRITICAL` image scanning.

The image job also emits CycloneDX SBOMs, Trivy SARIF, Docker image inspection records, image IDs, source commit/tree/archive digests, Dockerfile digests, and SHA-256 checksums. SARIF is uploaded to GitHub code scanning and the remaining evidence is retained as a short-lived workflow artifact. The builder refuses a dirty worktree or a requested evidence ID that differs from the checked-out commit.

Gradle verifies the pinned 8.11.1 distribution ZIP against the checksum
published for that exact distribution. Docker build stages, Compose services,
CI services, and recovery fixtures retain readable tags but resolve only through
checked-in multi-platform SHA-256 digests. Builds do not perform floating OS
package upgrades; base refreshes require a reviewed digest change and must pass
the blocking image scan. `npm run validate:container-inputs` rejects new mutable
Dockerfile `FROM` references, Compose/workflow image declarations,
`docker://` actions, recovery defaults, or Dockerfile package upgrades.
Maven/plugin dependency verification remains a separate gate.

Recovery image overrides are accepted only when the operator supplies an
explicit SHA-256 digest; the drill records the resolved references in its
evidence bundle.

`--ignore-unfixed` is intentional: findings without an upstream fix remain visible in reports but do not independently block this prototype workflow. This policy must be reviewed before production approval. An exception must never be created merely to obtain a green build.

## Tag and manual evidence

`.github/workflows/release-evidence.yml` runs for `v*` tags and manual dispatches. It can retain compressed Docker archives for the three locally built images for 30 days. Every file in the bundle is bound by `SHA256SUMS`, and CI immediately verifies the checksum file.

The artifact is deliberately named **unsigned release evidence**. The current repository does not provide:

- a trusted production registry or digest-pinned promotion contract;
- keyless or hardware-backed signing;
- SLSA provenance or an equivalent attestation;
- protected production-environment approval; or
- Android production signing and controlled rollout evidence.

Until those controls and the remaining pre-production gates are implemented and evidenced, the archives must not be described or used as production releases.

## Local reproduction

Install the pinned Trivy version documented in the workflows, then run:

```bash
RELEASE_EVIDENCE_DIR=release-evidence \
RELEASE_EVIDENCE_ID="$(git rev-parse HEAD)" \
RELEASE_EVIDENCE_ARCHIVES=false \
deploy/scripts/build-release-evidence.sh
```

The script refuses to overwrite an existing evidence directory. Set `RELEASE_EVIDENCE_ARCHIVES=true` only when local Docker archives are required and protected storage capacity is available.

## Promotion requirements

Before a production promotion exists, define and test registry immutability, signing identity and custody, provenance verification, release approvals, rollback retention, vulnerability exception ownership and expiry, APK signing, and deployment verification. Record the exact source commit, image digests, migration compatibility, approvers, recovery evidence, and pilot-device results in the release record.
