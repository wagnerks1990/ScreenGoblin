#!/usr/bin/env bash
set -Eeuo pipefail

umask 077
command -v docker >/dev/null
command -v sha256sum >/dev/null

readonly POSTGRES_FIXTURE="${POSTGRES_FIXTURE_IMAGE:-postgres:17-alpine}"
readonly MINIO_FIXTURE="${MINIO_FIXTURE_IMAGE:-minio/minio:RELEASE.2025-04-22T22-12-26Z}"
readonly MC_FIXTURE="${MC_FIXTURE_IMAGE:-minio/mc:RELEASE.2025-04-16T18-13-26Z}"
readonly ALPINE_FIXTURE="${ALPINE_FIXTURE_IMAGE:-alpine:3.22}"
readonly ROLLBACK_DOCKERFILE="${ROLLBACK_DOCKERFILE:-deploy/docker/api.Dockerfile}"
readonly EVIDENCE_DIR="${RECOVERY_EVIDENCE_DIR:-recovery-evidence}"

if [[ -e "$EVIDENCE_DIR" ]]; then
  echo "Refusing to overwrite existing recovery evidence: $EVIDENCE_DIR" >&2
  exit 2
fi
mkdir -p "$EVIDENCE_DIR"

work_dir="$(mktemp -d)"
network="screengoblin-recovery-${RANDOM}-${RANDOM}"
pg_container="${network}-postgres"
minio_container="${network}-minio"
cleanup() {
  docker rm -f "$pg_container" "$minio_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

resolve_fixture() {
  local tag="$1" digest
  docker pull "$tag" >/dev/null
  digest="$(docker image inspect "$tag" --format '{{index .RepoDigests 0}}')"
  [[ "$digest" == *@sha256:* ]] || { echo "Could not resolve immutable digest for $tag" >&2; exit 1; }
  printf '%s\n' "$digest"
}

pg_image="$(resolve_fixture "$POSTGRES_FIXTURE")"
minio_image="$(resolve_fixture "$MINIO_FIXTURE")"
mc_image="$(resolve_fixture "$MC_FIXTURE")"
alpine_image="$(resolve_fixture "$ALPINE_FIXTURE")"
printf '%s\n' "$pg_image" "$minio_image" "$mc_image" "$alpine_image" > "$work_dir/fixture-digests.txt"
cp "$work_dir/fixture-digests.txt" "$EVIDENCE_DIR/fixture-image-digests.txt"

docker network create "$network" >/dev/null
docker run --detach --pull never --name "$pg_container" --network "$network" \
  --env POSTGRES_PASSWORD=recovery-test-only --env POSTGRES_USER=screengoblin \
  --env POSTGRES_DB=screengoblin "$pg_image" >/dev/null
for attempt in {1..60}; do
  if docker exec "$pg_container" pg_isready -U screengoblin -d screengoblin >/dev/null 2>&1; then break; fi
  [[ "$attempt" -lt 60 ]] || { echo "PostgreSQL fixture did not become ready" >&2; exit 1; }
  sleep 1
done
docker exec "$pg_container" psql -U screengoblin -d screengoblin -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE recovery_probe (id integer PRIMARY KEY, value text NOT NULL);' \
  -c "INSERT INTO recovery_probe VALUES (1, 'verified');" >/dev/null
docker exec "$pg_container" pg_dump -U screengoblin -d screengoblin \
  --format=custom --no-owner --no-acl > "$work_dir/postgres.dump"
sha256sum "$work_dir/postgres.dump" > "$work_dir/postgres.dump.sha256"
sha256sum --check --strict "$work_dir/postgres.dump.sha256"
docker exec "$pg_container" createdb -U screengoblin screengoblin_restore_validation
docker exec -i "$pg_container" pg_restore -U screengoblin -d screengoblin_restore_validation \
  --exit-on-error --no-owner --no-acl < "$work_dir/postgres.dump"
[[ "$(docker exec "$pg_container" psql -U screengoblin -d screengoblin_restore_validation -Atc 'SELECT value FROM recovery_probe WHERE id=1')" == verified ]]

mkdir "$work_dir/object-backup"
docker run --detach --pull never --name "$minio_container" --network "$network" \
  --env MINIO_ROOT_USER=recoveryadmin --env MINIO_ROOT_PASSWORD=recovery-test-password \
  "$minio_image" server /data >/dev/null
for attempt in {1..60}; do
  if docker run --rm --pull never --network "$network" --env HOME=/tmp "$mc_image" \
    alias set local "http://$minio_container:9000" recoveryadmin recovery-test-password >/dev/null 2>&1; then break; fi
  [[ "$attempt" -lt 60 ]] || { echo "MinIO fixture did not become ready" >&2; exit 1; }
  sleep 1
done
printf 'ScreenGoblin recovery object\n' > "$work_dir/object.txt"
docker run --rm --pull never --network "$network" --volume "$work_dir:/work" \
  --user "$(id -u):$(id -g)" --env HOME=/tmp --entrypoint /bin/sh "$mc_image" -ceu "
  mc alias set local http://$minio_container:9000 recoveryadmin recovery-test-password >/dev/null
  mc mb local/recovery >/dev/null
  mc cp /work/object.txt local/recovery/object.txt >/dev/null
  mc mirror local/recovery /work/object-backup >/dev/null
  mc rb --force local/recovery >/dev/null
  mc mb local/recovery >/dev/null
  mc mirror /work/object-backup local/recovery >/dev/null
  mc cp local/recovery/object.txt /work/restored-object.txt >/dev/null
"
cmp "$work_dir/object.txt" "$work_dir/restored-object.txt"

docker build --pull --file "$ROLLBACK_DOCKERFILE" --tag screengoblin/recovery-current:test .
docker tag screengoblin/recovery-current:test screengoblin/recovery-retained:test
retained_id="$(docker image inspect screengoblin/recovery-retained:test --format '{{.Id}}')"
docker build --pull=false --file - --tag screengoblin/recovery-current:test . <<EOF
FROM $alpine_image
RUN printf 'replacement' > /release-marker
EOF
docker tag screengoblin/recovery-retained:test screengoblin/recovery-current:test
[[ "$(docker image inspect screengoblin/recovery-current:test --format '{{.Id}}')" == "$retained_id" ]]

cat > "$EVIDENCE_DIR/result.txt" <<EOF
Disposable PostgreSQL custom-format dump/restore: passed
Disposable MinIO delete/restore/byte comparison: passed
Retained Docker image rollback: passed
Retained image ID: $retained_id
EOF
(
  cd "$EVIDENCE_DIR"
  sha256sum fixture-image-digests.txt result.txt > SHA256SUMS
  sha256sum --check --strict SHA256SUMS
)

echo "PostgreSQL, MinIO, and retained-image rollback recovery checks passed"
