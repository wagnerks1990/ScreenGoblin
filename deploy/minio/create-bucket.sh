#!/bin/sh
set -eu

until mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"; do
  sleep 2
done

mc mb --ignore-existing "local/$S3_BUCKET"
sed "s/__BUCKET__/$S3_BUCKET/g" /api-policy.json > /tmp/api-policy.json
mc admin policy info local screengoblin-media-rw >/dev/null 2>&1 || \
  mc admin policy create local screengoblin-media-rw /tmp/api-policy.json
mc admin user info local "$S3_ACCESS_KEY_ID" >/dev/null 2>&1 || \
  mc admin user add local "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
mc admin policy attach local screengoblin-media-rw --user "$S3_ACCESS_KEY_ID"
mc anonymous set download "local/$S3_BUCKET"
