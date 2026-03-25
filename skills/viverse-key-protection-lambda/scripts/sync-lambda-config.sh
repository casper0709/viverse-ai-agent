#!/usr/bin/env bash
set -euo pipefail

# Skill template script.
# Copy into target project and customize EVENTS_JSON / env keys as needed.

ROOT_DIR="${ROOT_DIR:-$(pwd)}"
BASE_URL="${BASE_URL:-https://broadcasting-gateway-gaming.vrprod.viveport.com/api/play-lambda-service/v1}"
GAME_ID="${GAME_ID:-}"
APPROVE="${APPROVE:-false}"
EVENTS_JSON="${EVENTS_JSON:-[{\"event_name\":\"places_search_event\",\"script_path\":\"lambda/places_search_event.js\"}]}"

if [[ -z "${LAMBDA_AUTHKEY:-}" ]]; then
  echo "Missing LAMBDA_AUTHKEY" >&2
  exit 1
fi

if [[ -z "$GAME_ID" && -f "$ROOT_DIR/.env" ]]; then
  GAME_ID="$(awk -F= '/^VITE_VIVERSE_CLIENT_ID=/{print $2}' "$ROOT_DIR/.env" | tail -n1 | tr -d '"' | tr -d "'")"
fi

if [[ -z "$GAME_ID" ]]; then
  echo "Missing GAME_ID (or VITE_VIVERSE_CLIENT_ID)" >&2
  exit 1
fi

ts="$(date +%Y%m%d_%H%M%S)"
ART_DIR="$ROOT_DIR/artifacts/lambda-sync/$ts"
mkdir -p "$ART_DIR/request" "$ART_DIR/response"

auth_header="Authkey: ${LAMBDA_AUTHKEY}"

echo "[plan] fetching env..."
curl -sS "$BASE_URL/env?game_id=$GAME_ID" -H "$auth_header" > "$ART_DIR/response/current_env.json"

echo "[plan] syncing scripts listed in EVENTS_JSON..."
echo "$EVENTS_JSON" | jq -c '.[]' | while read -r item; do
  event_name="$(echo "$item" | jq -r '.event_name')"
  script_path="$(echo "$item" | jq -r '.script_path')"
  script_abs="$ROOT_DIR/$script_path"
  if [[ ! -f "$script_abs" ]]; then
    echo "Missing script: $script_abs" >&2
    exit 1
  fi

  curl -sS "$BASE_URL/script?game_id=$GAME_ID&event_name=$event_name" -H "$auth_header" > "$ART_DIR/response/current_script_${event_name}.json"
  jq -cn --arg game_id "$GAME_ID" --arg event_name "$event_name" --arg code "$(cat "$script_abs")" \
    '{game_id:$game_id,event_name:$event_name,code:$code}' > "$ART_DIR/request/desired_script_${event_name}.json"

  current_hash="$(jq -r '.code // .script.code // .data.code // empty' "$ART_DIR/response/current_script_${event_name}.json" | shasum -a 256 | awk '{print $1}')"
  desired_hash="$(cat "$script_abs" | shasum -a 256 | awk '{print $1}')"
  jq -cn --arg event_name "$event_name" --arg current_hash "$current_hash" --arg desired_hash "$desired_hash" \
    '{event_name:$event_name,script_changed:($current_hash!=$desired_hash),current_hash:$current_hash,desired_hash:$desired_hash}' \
    > "$ART_DIR/script_diff_${event_name}.json"
done

if [[ "$APPROVE" != "true" ]]; then
  echo "[plan] done. artifacts: $ART_DIR"
  exit 0
fi

echo "[apply] enabled"
echo "$EVENTS_JSON" | jq -c '.[]' | while read -r item; do
  event_name="$(echo "$item" | jq -r '.event_name')"
  changed="$(jq -r '.script_changed' "$ART_DIR/script_diff_${event_name}.json")"
  if [[ "$changed" == "true" ]]; then
    curl -sS -X POST "$BASE_URL/script" -H "$auth_header" -H "Content-Type: application/json" \
      --data-binary @"$ART_DIR/request/desired_script_${event_name}.json" > "$ART_DIR/response/apply_script_${event_name}.json"
  fi
done
echo "[apply] done. artifacts: $ART_DIR"

