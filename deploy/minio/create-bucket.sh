#!/bin/sh
set -eu

until mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do
  sleep 2
done

mc mb --ignore-existing "local/$S3_BUCKET"
policy_template="${MINIO_POLICY_TEMPLATE:-/api-policy.json}"
policy_output="${MINIO_POLICY_OUTPUT:-/tmp/api-policy.json}"
while IFS= read -r line || [ -n "$line" ]; do
  while [ "${line#*__BUCKET__}" != "$line" ]; do
    prefix="${line%%__BUCKET__*}"
    suffix="${line#*__BUCKET__}"
    line="${prefix}${S3_BUCKET}${suffix}"
  done
  printf '%s\n' "$line"
done < "$policy_template" > "$policy_output"
mc admin policy info local screengoblin-media-rw >/dev/null 2>&1 || \
  mc admin policy create local screengoblin-media-rw "$policy_output"
mc admin user info local "$S3_ACCESS_KEY_ID" >/dev/null 2>&1 || \
  mc admin user add local "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
mc admin policy attach local screengoblin-media-rw --user "$S3_ACCESS_KEY_ID"
mc anonymous set none "local/$S3_BUCKET"
