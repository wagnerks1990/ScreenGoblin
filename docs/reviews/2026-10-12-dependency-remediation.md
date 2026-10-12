# Dependency remediation — 2026-10-12

Status: draft; container image, Compose/runtime, and recovery gates remain blocked. Android lint/tests/builds/artifact policy passed in GitHub Actions. No production deployment, image publication, device access, or merge is authorized by this evidence.

## Source and isolation

Rebuilt from `origin/main` at `feb2db9b4ad3be8b573d7f0a9ff7832ec7bfb513` in an isolated worktree on `security/dependency-remediation-20261012`. The original checkout was clean and remains unchanged. Existing cloud workspaces and running cloud PostgreSQL/Redis services were not modified. Tests used a separate disposable PostgreSQL container on loopback port 55432. Validation ran on native Linux in the available executor, not Windows or WSL2.

## Dependency changes

| Dependency                            | Before                  | After            |
| ------------------------------------- | ----------------------- | ---------------- |
| concurrently                          | 9.2.4                   | 9.2.5            |
| shell-quote                           | 1.9.0                   | 1.12.0           |
| brace-expansion                       | 5.0.9                   | 5.0.12           |
| source-map-js                         | 1.2.1                   | 1.2.2            |
| fast-jwt                              | 6.3.3                   | 6.3.4            |
| fastify                               | 5.12.3                  | 5.12.5           |
| fast-uri (AJV-compatible instances)   | 3.1.7                   | 3.1.8            |
| fast-uri (root)                       | 4.1.4                   | 4.2.2            |
| Bouncy Castle provider, PKIX, utility | 1.84                    | 1.85             |
| Commons Compress                      | 1.21                    | 1.28.0           |
| Commons Codec (Compress transitive)   | 1.11                    | 1.19.0           |
| Commons IO (Compress transitive)      | 2.16.1                  | 2.20.0           |
| Commons Lang (Compress transitive)    | absent                  | 3.18.0           |
| API PCRE2                             | 10.42-1+deb12u1         | 10.42-1+deb12u2  |
| API OpenSSL/libssl3                   | 3.0.20-1~deb12u2        | 3.0.22-1~deb12u1 |
| API perl-base                         | inherited base revision | 5.36.0-7+deb12u4 |

Direct npm minimums were raised for Fastify and concurrently; transitive versions remain compatible with their parents. Registry-generated lock integrity is retained. Gradle regenerated affected buildscript locks and Maven SHA-256 metadata, including Compress transitives, with targeted `--update-locks` and `help`. This resolves the affected classpaths but does **not** establish full lint/test/build graph validation. Component metadata also rewrites the affected transitive versions for AGP lint detached configurations, which are not visited by `configurations.configureEach`. Obsolete Bouncy Castle 1.79/1.84 and Compress 1.21 verification entries were removed. The repository gate and regression fixtures enforce the new secure versions across root, generated buildscript, and project resolution; no assertion was weakened.

Exact Debian revisions were checked against the current Bookworm security Packages index and installed through apt in the image. The immutable Node/nginx base digests, non-root runtime, npm removal, health checks, and production-only dependency install are preserved.

## Validation results

| Check                                          | Actual result                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean npm installation                         | PASS: `npm ci`                                                                                                                                                                   |
| npm audit                                      | PASS: 0 findings after remediation                                                                                                                                               |
| Official `npm run validate`                    | PASS: complete official pipeline (policy, Prisma, formatting, lint, types, 136 repository tests, 672 application tests, builds)                                                  |
| Application coverage                           | PASS: API 344, Console 93, Player 235 tests (672 total)                                                                                                                          |
| PostgreSQL integration                         | PASS: 72 tests against migrated isolated PostgreSQL                                                                                                                              |
| Runtime database privilege integration         | PASS: 3 tests; PUBLIC CREATE contamination reconciled                                                                                                                            |
| Chromium E2E                                   | PASS: 9 tests, including accessibility and live session failure paths                                                                                                            |
| Android sync                                   | PASS                                                                                                                                                                             |
| Gradle affected lock/verification regeneration | PASS: targeted update with `help`; subsequent `--dependency-verification=strict help` also passed                                                                                |
| Android lint                                   | PASS in GitHub Actions; local attempt blocked by Google Maven HTTP 503                                                                                                           |
| Android unit/debug/release build tasks         | PASS in GitHub Actions; local attempt blocked by Google Maven AAPT2 HTTP 503                                                                                                     |
| APK release-surface verification               | PASS in GitHub Actions: packaged release policy; unsigned release and debug APK artifacts uploaded                                                                               |
| API and Console Docker builds                  | PASS with temporary session CA mounts                                                                                                                                            |
| Player Docker build                            | PASS in GitHub Compose build; local attempt blocked by npm HTTP 503 for `util-deprecate`                                                                                         |
| Isolated Compose smoke / runtime DAST          | BLOCKED: pinned Quay MinIO pull unauthorized                                                                                                                                     |
| API image runtime probes                       | PASS: UID 10001, fixed package revisions, npm absent, missing-secret startup rejected; isolated production readiness 204 and Redis-outage readiness 503                          |
| Trivy repository vulnerabilities               | PASS: 0 findings with development dependencies included                                                                                                                          |
| Trivy repository secrets                       | PASS: 0 findings under existing exact exceptions                                                                                                                                 |
| Trivy configuration                            | PASS: 0 findings under existing exceptions; embedded checks used because downloaded check cache was unavailable                                                                  |
| Dependency license policy and Trivy inventory  | PASS: 499 npm entries, 11 accepted license expressions; Trivy inventory generated                                                                                                |
| SBOM generation                                | PASS: repository, API and Console CycloneDX SBOMs generated outside source                                                                                                       |
| API image fixed HIGH/CRITICAL gate             | PASS: 0 fixable HIGH/CRITICAL; unfixed findings retained below                                                                                                                   |
| Console image fixed HIGH/CRITICAL gate         | FAIL: 3 existing fixable HIGH findings in pinned Alpine base                                                                                                                     |
| Player image scan / SBOM                       | SKIPPED: local build blocked; CI image evidence gate stopped on Console findings before Player scanning                                                                          |
| GitHub Actions                                 | Completed code follow-up: web/API, browser, Android, repository scan, dependency review and CodeQL passed. Compose, image scan and recovery failed for remaining blockers below. |

The first browser run failed after overlapping local builds overwrote the Console API URL. A serial rebuild with the workflow's E2E settings passed all 9 tests without changing assertions. The initially installed Java 21 was a JRE without a compiler; a full JDK 21 and Android SDK 35 were installed outside the repository. Java used the supported session proxy and system CA trust. The initial direct Docker builds failed npm installation without session CA trust; temporary Dockerfiles outside the repository mounted the CA as a BuildKit secret. No session certificate or proxy configuration is committed or copied into image layers.

## Vulnerability counts

Trivy 0.74.0 was downloaded from its immutable release asset and verified against the repository workflow SHA-256. Counts below use the same cached database and include development dependencies for repository comparisons. Counts are scanner findings, not deduplicated CVEs across ecosystems.

| Scan                           | Before                            | After |
| ------------------------------ | --------------------------------- | ----- |
| npm audit                      | 7: 2 critical, 2 high, 3 moderate | 0     |
| Trivy npm + Gradle locks       | 14: 2 critical, 4 high, 8 medium  | 0     |
| Trivy Android buildscript lock | 4: 1 critical, 1 high, 2 medium   | 0     |

The **pinned Node base**, not a reconstructed old final API image, has 5 critical, 71 high, 117 medium, 78 low, and 7 unknown findings. The rebuilt API final image has 1 critical, 52 high, 104 medium, 81 low, and 7 unknown findings; none of its HIGH/CRITICAL findings has a published Debian fix in the scan. These are not equivalent before/after final-image populations: the final image includes application dependencies and removes npm/Corepack. Do not interpret the base comparison as a final-image remediation count.

The Console final image retains 3 HIGH and 3 MEDIUM fixable findings: libexpat `2.8.4-r0` → `2.8.5-r0`, PCRE2 `10.48-r0` → `10.49-r0`, TIFF `4.7.1-r0` → `4.7.2-r0`, libpng `1.6.58-r1` → `1.6.59-r0`, nghttp2-libs `1.69.0-r0` → `1.70.0-r0`, zlib `1.3.2-r0` → `1.3.2-r1`. The unchanged nginx base is shared with Player. Alpine index access returned HTTP 503, so those scanner-suggested revisions were not accepted as verified distribution updates.

## Infrastructure failures and remaining gates

- Google Maven returned HTTP 503 for `https://dl.google.com/dl/android/maven2/com/android/tools/lint/lint-gradle/31.10.1/lint-gradle-31.10.1.pom` on repeated attempts and for `https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2/8.10.1-12782657/aapt2-8.10.1-12782657.pom`. The local full Android graph remained blocked; GitHub Actions subsequently passed lint/unit/debug/release tasks and packaged artifact policy inspection. New Maven artifact checksum sidecar requests also returned HTTP 503; metadata was generated from the actual downloaded artifacts, without independent published-sidecar matching.
- Quay returned `unauthorized: access to the requested resource is not authorized` for the repository-pinned MinIO image during the isolated Compose smoke test. No existing service was stopped or reused. Compose, ZAP DAST, complete runtime network/readiness checks, and recovery evidence remain unvalidated.
- The Player Docker install returned `E503 ... GET https://registry.npmjs.org/util-deprecate`; a Dockerfile frontend pull also returned registry HTTP 503 before retrying with the builtin frontend. The Player image subsequently built successfully in GitHub Actions, but its image scan/SBOM evidence remains missing because the blocking image gate stopped at Console findings.
- `https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/APKINDEX.tar.gz` returned HTTP 503 twice. Console/Player Alpine updates require authenticated package-index/build verification and new image scans.
- Raw logs and SBOMs are in the separate local evidence directory `/workspace/scratch/security-20261012`; they are not committed. This report records measured results without treating incomplete gates as passed.

Rollback is a reviewed revert of the dependency change; reverting restores known findings and is not a secure production release. Keep the PR draft until all required gates, including remaining container fixes, are complete. Do not merge, auto-merge, deploy, or publish production images.

## Publication and GitHub Actions

GitHub Git transport returned HTTP 503 on both push attempts (`upstream connect error ... remote address:envoy://cloudflare_https_tunnel/`). The connected GitHub API published the reviewed tree instead. Local commit `020f1040e6b650c963884cc6e8278d85dd928556` and remote commit `d31c954300c50efad98e395d39ac90b0ee6d57b4` have exactly the same tree `4a983b029e8b5796f47bdbf392032eac4fed78d9`. Draft PR: https://github.com/wagnerks1990/ScreenGoblin/pull/128.

On the initial remote commit, web/API and browser E2E jobs passed, as did dependency review and all three CodeQL languages; repository vulnerability/secret/configuration/license scanning also passed. Recovery failed on the same pinned Quay MinIO authorization error. The image gate passed the API scan, then failed on the three unchanged Console Alpine HIGH findings. Android failed strict verification because lint's detached configuration requested old Bouncy Castle 1.79 and Compress 1.21 after their verification entries were removed. The follow-up change rewrites component metadata for those transitive requests so detached configurations select the secure versions, preserving strict checks rather than restoring vulnerable artifacts. The complete local `npm run validate` pipeline, strict Gradle configuration, and policy regression tests passed again after that correction; full local lint/build validation still depends on unavailable Google Maven artifacts. An additional offline detached-configuration probe resolved the actual APK library/repository tool transitives and strictly verified Bouncy Castle 1.85 and Compress 1.28.0. The initial supplemental production-health probe omitted S3 configuration and exited before serving requests; the corrected probe passed with ephemeral S3 configuration, independent secrets, and isolated PostgreSQL/Redis. The read-only, capability-dropped, no-new-privileges API returned live/ready 204 and unauthenticated management 401; stopping its test Redis returned ready 503 while live stayed 204. These component checks do not replace missing full Compose/DAST evidence.

### Completed code follow-up

Published follow-up `192a5f3c2d8485f32bbba30c237c130ad516786c` matches local commit `c97e998b5092a1be67dea6d55b41ce619348a768` at tree `bb26b0f92a529becfde2961aa9092dfc7eefddf2`. GitHub tested PR merge commit `90c686f82fac31268e17cc25354f1b105db63fae`, whose tree was independently checked to equal that same tree. This report-only follow-up records those completed results without changing the tested dependency/build code.

- [CI run 605](https://github.com/wagnerks1990/ScreenGoblin/actions/runs/38320293003): web/API, browser E2E and Android jobs passed. Android executed strict `lint test assembleDebug assembleRelease` and its packaged release validator reported exact-policy success. Artifacts: debug APK ID `11778316599`, release-surface/unsigned APK ID `11778456478`. The container job built API, Console and Player, then failed the MinIO pull with Quay `unauthorized`. The overall CI result remains failure.
- [Dependency review run 520](https://github.com/wagnerks1990/ScreenGoblin/actions/runs/38320293026): passed.
- [CodeQL run 505](https://github.com/wagnerks1990/ScreenGoblin/actions/runs/38320293093): JavaScript/TypeScript, Java/Kotlin and Actions passed.
- [Container scan run 508](https://github.com/wagnerks1990/ScreenGoblin/actions/runs/38320293009): repository job passed; image job passed API then failed Console's three fixable HIGH findings. It did not reach Player image evidence.
- [Recovery run 308](https://github.com/wagnerks1990/ScreenGoblin/actions/runs/38320293102): failed before recovery on the pinned Quay MinIO authorization error.

The uploaded unsigned APK and manifest report are CI artifact-policy evidence, not production signing or physical-device validation. An attempted download of the release ZIP into this executor failed; no independent local APK extraction is claimed. Local logs/SBOMs were sealed with SHA-256 in the separate evidence directory. Disposable test containers were removed; the original checkout and cloud services remain intact. Keep PR #128 draft until container fixes and complete smoke/DAST/recovery/image evidence are available.

## Follow-up: Alpine runtime remediation

Both nginx runtime stages now install exact `libexpat=2.8.5-r0`,
`pcre2=10.49-r0`, and `tiff=4.7.2-r0` packages from the signed Alpine 3.24
repository. These address CVE-2026-93990, CVE-2026-103111, and CVE-2026-4775.
The immutable base digest remains pinned; package installation uses root only
during build and the final runtime still uses `USER nginx`. No blanket upgrade,
scanner exclusion, runtime privilege expansion, or production operation occurs.

The signed Alpine index lists all three exact versions. An isolated container
from the pinned base successfully installed all three packages and passed
`nginx -t`; the session proxy CA was mounted only for that disposable test.
Hosted image scanning remains required before qualifying the PR.

The MinIO Quay authorization failure remains reproducible; the same historical
Docker Hub tags also returned manifest HTTP 401. No unverified substitute image
was adopted. Main ruleset update to actual hosted checks was denied HTTP 403;
`windows-agent` and `validate` remain unsatisfiable required contexts.
