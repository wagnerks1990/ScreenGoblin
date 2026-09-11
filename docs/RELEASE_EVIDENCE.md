# Release evidence

ScreenGoblin CI builds the final API, Console, and web-player container stages and records evidence about those exact local images. Evidence does not turn a commit into an approved production release.

## Pull-request and scheduled scanning

`.github/workflows/container-scan.yml` performs two blocking checks:

- repository filesystem scanning for unresolved `HIGH` and `CRITICAL` findings; and
- final-image builds followed by unresolved `HIGH` and `CRITICAL` image scanning.

The image job also emits CycloneDX SBOMs, Trivy SARIF, Docker image inspection records, image IDs, source commit/tree/archive digests, Dockerfile digests, and SHA-256 checksums. SARIF is uploaded to GitHub code scanning and the remaining evidence is retained as a short-lived workflow artifact. The builder refuses a dirty worktree or a requested evidence ID that differs from the checked-out commit.

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
