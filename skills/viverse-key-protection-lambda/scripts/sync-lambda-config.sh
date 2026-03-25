#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export LANG=C

usage() {
  cat <<'EOF'
Usage:
  sync-lambda-config.sh [--approve] [--verify] [--base-url URL] [--game-id ID] [--env-file PATH] [--events-json JSON] [--env-keys K1,K2]

Behavior:
  - Dry-run by default: fetch current /env + /script, compute diff artifacts, no remote mutation.
  - --approve: apply POST /env and POST /script only when drift exists.
  - --verify: query jobs list after apply and save artifact.

Defaults:
  --base-url   https://broadcasting-gateway-gaming.vrprod.viveport.com/api/play-lambda-service/v1
  --env-file   .env.lambda.local (optional)
  --env-keys   GOOGLE_PLACES_API_KEY,GOOGLE_PLACES_TEXT_SEARCH_URL,GOOGLE_TILES_API_KEY,GOOGLE_TILES_ROOT_URL
  --events-json '[{"event_name":"places_search_event","script_path":"lambda/places_search_event.js"},{"event_name":"tiles_root_bootstrap_event","script_path":"lambda/tiles_root_bootstrap_event.js"}]'

Required env:
  - LAMBDA_AUTHKEY

Examples:
  Plan:
    ./scripts/sync-lambda-config.sh

  Apply after review:
    ./scripts/sync-lambda-config.sh --approve --verify
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-https://broadcasting-gateway-gaming.vrprod.viveport.com/api/play-lambda-service/v1}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.lambda.local}"
ENV_KEYS_CSV="${ENV_KEYS_CSV:-GOOGLE_PLACES_API_KEY,GOOGLE_PLACES_TEXT_SEARCH_URL,GOOGLE_TILES_API_KEY,GOOGLE_TILES_ROOT_URL}"
DEFAULT_EVENTS_JSON='[{"event_name":"places_search_event","script_path":"lambda/places_search_event.js"},{"event_name":"tiles_root_bootstrap_event","script_path":"lambda/tiles_root_bootstrap_event.js"}]'
EVENTS_JSON="${EVENTS_JSON:-}"
GAME_ID="${GAME_ID:-}"
APPROVE="false"
VERIFY="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --approve) APPROVE="true"; shift ;;
    --verify) VERIFY="true"; shift ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    --game-id) GAME_ID="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --events-json) EVENTS_JSON="$2"; shift 2 ;;
    --env-keys) ENV_KEYS_CSV="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${LAMBDA_AUTHKEY:-}" ]]; then
  echo "Missing required env: LAMBDA_AUTHKEY" >&2
  exit 1
fi

if [[ -z "$GAME_ID" && -f "$ROOT_DIR/.env" ]]; then
  GAME_ID="$(awk -F= '/^VITE_VIVERSE_CLIENT_ID=/{print $2}' "$ROOT_DIR/.env" | tail -n1 | tr -d '"' | tr -d "'")"
fi

if [[ -z "$GAME_ID" ]]; then
  echo "Missing game id. Provide --game-id or set VITE_VIVERSE_CLIENT_ID in .env" >&2
  exit 1
fi

if [[ -z "$EVENTS_JSON" ]]; then
  EVENTS_JSON="$DEFAULT_EVENTS_JSON"
fi
if ! echo "$EVENTS_JSON" | jq -e . >/dev/null 2>&1; then
  echo "Invalid EVENTS_JSON detected from environment/args. Falling back to internal default." >&2
  EVENTS_JSON="$DEFAULT_EVENTS_JSON"
fi

ts="$(date +%Y%m%d_%H%M%S)"
ART_DIR="$ROOT_DIR/artifacts/lambda-sync/$ts"
mkdir -p "$ART_DIR/request" "$ART_DIR/response"
auth_header="Authkey: ${LAMBDA_AUTHKEY}"

echo "[1/7] Fetching current env..."
curl -sS "$BASE_URL/env?game_id=$GAME_ID" -H "$auth_header" > "$ART_DIR/response/current_env.json"

echo "[2/7] Building desired env payload..."
IFS=',' read -r -a env_keys <<< "$ENV_KEYS_CSV"
env_obj='{}'
for key in "${env_keys[@]}"; do
  key="$(echo "$key" | xargs)"
  [[ -z "$key" ]] && continue
  val="${!key:-}"
  if [[ -n "$val" ]]; then
    env_obj="$(jq -cn --argjson base "$env_obj" --arg k "$key" --arg v "$val" '$base + {($k):$v}')"
  fi
done
jq -cn --arg game_id "$GAME_ID" --argjson variables "$env_obj" \
  '{game_id:$game_id, variables:$variables}' > "$ART_DIR/request/desired_env_payload.json"

echo "[3/7] Fetching/building scripts..."
echo "$EVENTS_JSON" | jq -c '.[]' > "$ART_DIR/events.list"
while read -r ev; do
  event_name="$(echo "$ev" | jq -r '.event_name')"
  script_path="$(echo "$ev" | jq -r '.script_path')"
  script_abs="$ROOT_DIR/$script_path"
  if [[ ! -f "$script_abs" ]]; then
    echo "Missing script file: $script_abs" >&2
    exit 1
  fi
  curl -sS "$BASE_URL/script?game_id=$GAME_ID&event_name=$event_name" -H "$auth_header" > "$ART_DIR/response/current_script_${event_name}.json"
  jq -cn --arg game_id "$GAME_ID" --arg event_name "$event_name" --arg code "$(cat "$script_abs")" \
    '{game_id:$game_id, event_name:$event_name, code:$code}' > "$ART_DIR/request/desired_script_${event_name}.json"
done < "$ART_DIR/events.list"

echo "[4/7] Computing drift..."
jq -r 'if .success == true then (.variables // {}) elif .variables then .variables else {} end' \
  "$ART_DIR/response/current_env.json" > "$ART_DIR/current_env_vars.json"
jq -r '.variables // {}' "$ART_DIR/request/desired_env_payload.json" > "$ART_DIR/desired_env_vars.json"

jq -n --slurpfile cur "$ART_DIR/current_env_vars.json" --slurpfile des "$ART_DIR/desired_env_vars.json" '
{
  added: (($des[0]|keys) - ($cur[0]|keys)),
  removed: (($cur[0]|keys) - ($des[0]|keys)),
  changed: [ (($des[0]|keys[]) as $k | select((($cur[0][$k]) // null) != ($des[0][$k])) | $k) ]
}' > "$ART_DIR/env_diff.json"

echo '[]' > "$ART_DIR/script_diff.json"
while read -r ev; do
  event_name="$(echo "$ev" | jq -r '.event_name')"
  script_path="$(echo "$ev" | jq -r '.script_path')"
  current_code="$(jq -r '.code // .script.code // .data.code // empty' "$ART_DIR/response/current_script_${event_name}.json")"
  desired_code="$(cat "$ROOT_DIR/$script_path")"
  current_hash="$(printf '%s' "$current_code" | shasum -a 256 | awk '{print $1}')"
  desired_hash="$(printf '%s' "$desired_code" | shasum -a 256 | awk '{print $1}')"
  jq --arg event_name "$event_name" --arg script_path "$script_path" --arg current_hash "$current_hash" --arg desired_hash "$desired_hash" \
    '. + [{event_name:$event_name,script_path:$script_path,script_changed:($current_hash != $desired_hash),current_hash:$current_hash,desired_hash:$desired_hash}]' \
    "$ART_DIR/script_diff.json" > "$ART_DIR/script_diff.tmp.json"
  mv "$ART_DIR/script_diff.tmp.json" "$ART_DIR/script_diff.json"
done < "$ART_DIR/events.list"

jq -n --slurpfile env_diff "$ART_DIR/env_diff.json" --slurpfile script_diff "$ART_DIR/script_diff.json" '
{
  env: { added: (($env_diff[0].added)|length), removed: (($env_diff[0].removed)|length), changed: (($env_diff[0].changed)|length) },
  scripts: $script_diff[0]
}' > "$ART_DIR/summary.json"

echo "[5/7] Writing redacted review artifacts..."
jq 'with_entries(if (.key | test("KEY|TOKEN|SECRET|PASSWORD|AUTH"; "i")) then .value="***REDACTED***" else . end)' \
  "$ART_DIR/desired_env_vars.json" > "$ART_DIR/desired_env_vars.redacted.json"

cat "$ART_DIR/summary.json"
echo "Artifacts: $ART_DIR"

if [[ "$APPROVE" != "true" ]]; then
  echo "[6/7] Dry-run complete. Re-run with --approve after manual review."
  exit 0
fi

echo "[6/7] Apply mode..."
apply_env="$(jq -r '((.added|length)+(.removed|length)+(.changed|length)) > 0' "$ART_DIR/env_diff.json")"
if [[ "$apply_env" == "true" ]]; then
  curl -sS -X POST "$BASE_URL/env" -H "$auth_header" -H "Content-Type: application/json" \
    --data-binary @"$ART_DIR/request/desired_env_payload.json" > "$ART_DIR/response/apply_env.json"
fi

while read -r ev; do
  event_name="$(echo "$ev" | jq -r '.event_name')"
  changed="$(jq -r --arg event_name "$event_name" '.[] | select(.event_name==$event_name) | .script_changed' "$ART_DIR/script_diff.json")"
  if [[ "$changed" == "true" ]]; then
    curl -sS -X POST "$BASE_URL/script" -H "$auth_header" -H "Content-Type: application/json" \
      --data-binary @"$ART_DIR/request/desired_script_${event_name}.json" > "$ART_DIR/response/apply_script_${event_name}.json"
  fi
done < "$ART_DIR/events.list"

if [[ "$VERIFY" == "true" ]]; then
  echo "[7/7] Verify via jobs API..."
  curl -sS "$BASE_URL/jobs?game_id=$GAME_ID&size=20" -H "$auth_header" > "$ART_DIR/response/jobs_latest.json"
  echo "Verify artifact: $ART_DIR/response/jobs_latest.json"
else
  echo "[7/7] Done (verify skipped)."
fi
