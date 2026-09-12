# Static security policy

The repository scan in `.github/workflows/container-scan.yml` is blocking for
three independently visible policies:

- Trivy repository secret findings;
- Trivy infrastructure-as-code and configuration misconfigurations; and
- dependency licenses recorded in `package-lock.json`.

Trivy is installed from the existing versioned release asset only after its
repository-reviewed SHA-256 digest is verified. The workflow does not install a
second scanner or use a floating action reference.

## Exceptions

`static-scan-exceptions.json` is the only source for secret or
misconfiguration exceptions. Every entry must name one scanner, one finding ID,
one to ten literal repository-relative files, a specific justification, and an
expiry no more than 90 days away. Wildcards, directory-wide paths, expired
entries, duplicate entries, and unknown fields fail validation. The generated
Trivy ignore file is temporary CI state and must not be committed.

`dependency-license-policy.json` contains the exact accepted license
expressions. Every non-link `node_modules` lock entry must have a derivable
package identity, exact version and license, and validated provenance. HTTPS
artifacts require SHA-512 integrity, `file:` locators must be repository-relative,
and git locators must end in a full commit SHA. A non-link entry without a
locator is still inventoried and marked `lockfile-unresolved`; when an exact
package-version entry has validated provenance elsewhere in the lockfile, that
provenance kind is inherited instead.

A temporary exception must identify an exact package, version, and license
expression, include a justification, and expire within 90 days. Unused,
duplicate, expired, or imprecise exceptions fail validation. Adding a new
license to the permanent allowlist requires normal security review; do not use
an exception to bypass an unknown dependency identity.

Run `npm run validate:static-security-policy` after changing either policy or
the lockfile. The pull-request workflow also emits deterministic, sanitized
license evidence and a checksum manifest. The evidence records only a validated provenance kind and omits registry URLs,
file paths, git locators, and integrity material. Secret and misconfiguration SARIF is uploaded only after
the blocking scans succeed so a detected secret is not retained as an artifact.

These repository checks are static pre-production controls. They do not perform
DAST, inspect a deployed service, continuously monitor production, or prove
runtime configuration and secret rotation.
