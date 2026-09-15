#!/usr/bin/env bash
set -euo pipefail

results_dir="${1:-codeql-results}"
mapfile -d '' sarif_files < <(find "$results_dir" -type f -name '*.sarif' -print0)
if (( ${#sarif_files[@]} == 0 )); then
  echo "No CodeQL SARIF output was produced" >&2
  exit 1
fi

approved_boot_receiver=false
if echo "82bae2a6c5eb8a1544955bde0ee6df85766d4e2d2491726f6b4ffcb2fd754d3a  apps/player/android/app/src/main/java/com/screengoblin/player/BootReceiver.java" \
    | sha256sum --check --status \
  && echo "81cdaccae61838db742fd21fee0353e8ba0d91dc49b6aede44b6dff6e8614801  apps/player/android/app/src/main/AndroidManifest.xml" \
    | sha256sum --check --status; then
  approved_boot_receiver=true
fi

approved_sigv4=false
mapfile -t sigv4_constructor_sources < <(
  git grep -lF 'new S3MediaObjectStore' -- '*.js' '*.jsx' '*.ts' '*.tsx' || true
)
expected_sigv4_sources=(
  "apps/api/src/server.ts"
  "apps/api/test/media-delivery.test.ts"
)
sigv4_finding_count="$(jq -s \
  '[.[].runs[]?.results[]? | select(.ruleId == "js/insufficient-password-hash")] | length' \
  "${sarif_files[@]}")"
if [[ "${sigv4_constructor_sources[*]}" == "${expected_sigv4_sources[*]}" ]] \
  && [[ "$sigv4_finding_count" == "1" ]] \
  && [[ "$(git hash-object apps/api/src/server.ts)" == "7fb97c881f9ca5e52fcdd6c7fc8ac6bc8f902457" ]] \
  && [[ "$(git hash-object apps/api/test/media-delivery.test.ts)" == "da0c876703f7e5c9a863f9b48ba39a115ebae777" ]] \
  && [[ "$(git hash-object apps/api/src/media/delivery.ts)" == "29148e088df4c95a8f8d7d3b5cb456f22ed6324b" ]]; then
  approved_sigv4=true
fi

blocking_result='def approved_false_positive:
  (($approved_boot_receiver
    and .ruleId == "java/improper-intent-verification"
    and (.locations | length) == 1
    and .locations[0].physicalLocation.artifactLocation.uri
      == "apps/player/android/app/src/main/java/com/screengoblin/player/BootReceiver.java")
  or ($approved_sigv4
    and .ruleId == "js/insufficient-password-hash"
    and .message.text
      == "Password from [a call to S3MediaObjectStore](1) is hashed insecurely.\nPassword from [a call to S3MediaObjectStore](2) is hashed insecurely.\nPassword from [a call to S3MediaObjectStore](3) is hashed insecurely."
    and (.locations | length) == 1
    and .locations[0].physicalLocation.artifactLocation.uri
      == "apps/api/src/media/delivery.ts"
    and .locations[0].physicalLocation.region
      == {"startLine": 238, "startColumn": 35, "endColumn": 51}
    and (.codeFlows | length) == 3
    and all(.codeFlows[]; (.threadFlows | length) == 1)
    and [.codeFlows[].threadFlows[0].locations[0].location.physicalLocation.artifactLocation.uri]
      == ["apps/api/test/media-delivery.test.ts", "apps/api/test/media-delivery.test.ts", "apps/api/test/media-delivery.test.ts"]
    and [.codeFlows[].threadFlows[0].locations[0].location.physicalLocation.region.startLine]
      == [160, 188, 214]
    and ([.codeFlows[].threadFlows[].locations[].location.physicalLocation.artifactLocation.uri] | unique)
      == ["apps/api/src/media/delivery.ts", "apps/api/test/media-delivery.test.ts"]));
  def evidence_only_uri:
  gsub("\\\\"; "/")
  | test("(^|/)node_modules/|(^|/)apps/player/android/([^/]+/)?build/");
  (approved_false_positive | not)
  and ((.locations // []) as $locations
    | if ($locations | length) == 0 then true
      else any($locations[];
        (.physicalLocation.artifactLocation.uri // "") as $uri
        | ($uri == "") or (($uri | evidence_only_uri) | not)
      ) end)'

finding_count="$(jq -s \
  --argjson approved_boot_receiver "$approved_boot_receiver" \
  --argjson approved_sigv4 "$approved_sigv4" \
  "[.[].runs[]?.results[]? | select(${blocking_result})] | length" \
  "${sarif_files[@]}")"
if (( finding_count > 0 )); then
  jq -r \
    --argjson approved_boot_receiver "$approved_boot_receiver" \
    --argjson approved_sigv4 "$approved_sigv4" \
    ".runs[]?.results[]? | select(${blocking_result})
    | \"\(.ruleId): \(.message.text)\"" "${sarif_files[@]}"
  echo "CodeQL reported ${finding_count} first-party finding(s)" >&2
  exit 1
fi
