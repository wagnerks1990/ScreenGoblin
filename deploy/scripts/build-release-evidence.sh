#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly OUTPUT_DIR="${RELEASE_EVIDENCE_DIR:-release-evidence}"
readonly RELEASE_ID="${RELEASE_EVIDENCE_ID:-$(git rev-parse --verify HEAD)}"
readonly INCLUDE_ARCHIVES="${RELEASE_EVIDENCE_ARCHIVES:-false}"
readonly TRIVY_BIN="${TRIVY_BIN:-trivy}"

case "$INCLUDE_ARCHIVES" in
  true|false) ;;
  *) echo "RELEASE_EVIDENCE_ARCHIVES must be true or false" >&2; exit 2 ;;
esac

command -v docker >/dev/null
command -v "$TRIVY_BIN" >/dev/null
command -v sha256sum >/dev/null

readonly SOURCE_COMMIT="$(git rev-parse --verify HEAD)"
if [[ "$RELEASE_ID" != "$SOURCE_COMMIT" ]]; then
  echo "RELEASE_EVIDENCE_ID must equal the checked-out source commit" >&2
  exit 2
fi
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Refusing to create release evidence from a dirty worktree" >&2
  exit 2
fi
if [[ -e "$OUTPUT_DIR" ]]; then
  echo "Refusing to overwrite existing evidence directory: $OUTPUT_DIR" >&2
  exit 2
fi
mkdir -p "$OUTPUT_DIR/images" "$OUTPUT_DIR/sbom" "$OUTPUT_DIR/sarif"

printf '%s\n' "$SOURCE_COMMIT" > "$OUTPUT_DIR/source-commit.txt"
git rev-parse --verify 'HEAD^{tree}' > "$OUTPUT_DIR/source-tree.txt"
git archive --format=tar HEAD | sha256sum | awk '{print $1}' > "$OUTPUT_DIR/source-archive.sha256"

declare -A dockerfiles=(
  [api]="deploy/docker/api.Dockerfile"
  [console]="deploy/docker/console.Dockerfile"
  [player-web]="deploy/docker/player.Dockerfile"
)

for component in api console player-web; do
  image="screengoblin/${component}:evidence-${RELEASE_ID:0:12}"
  sha256sum "${dockerfiles[$component]}" > "$OUTPUT_DIR/images/${component}.dockerfile.sha256"
  docker build --pull --file "${dockerfiles[$component]}" --tag "$image" .

  docker image inspect "$image" \
    --format '{{json .}}' > "$OUTPUT_DIR/images/${component}.inspect.json"
  docker image inspect "$image" \
    --format '{{.Id}}' > "$OUTPUT_DIR/images/${component}.image-id.txt"

  "$TRIVY_BIN" image --quiet --ignore-unfixed --severity HIGH,CRITICAL \
    --format sarif --output "$OUTPUT_DIR/sarif/${component}.sarif" "$image"
  "$TRIVY_BIN" image --quiet --ignore-unfixed --severity HIGH,CRITICAL \
    --exit-code 1 "$image"
  "$TRIVY_BIN" image --quiet --format cyclonedx \
    --output "$OUTPUT_DIR/sbom/${component}.cdx.json" "$image"

  if [[ "$INCLUDE_ARCHIVES" == true ]]; then
    docker save "$image" | gzip -n > "$OUTPUT_DIR/images/${component}.docker.tar.gz"
  fi
done

cat > "$OUTPUT_DIR/README.txt" <<EOF
ScreenGoblin build and security evidence
Source revision: $RELEASE_ID

This directory is checksum-bound CI evidence. It is not a production release
and does not independently establish provenance. A tag workflow may package it
and bind the archive digest to GitHub OIDC provenance; verify that external
attestation before relying on it. Promotion still requires the approvals,
production signing, registry, deployment, and recovery gates in
docs/PREPRODUCTION.md.
EOF

(
  cd "$OUTPUT_DIR"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum > SHA256SUMS
  sha256sum --check --strict SHA256SUMS
)

echo "Evidence written to $OUTPUT_DIR"
