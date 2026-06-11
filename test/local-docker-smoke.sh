#!/usr/bin/env bash
set -Eeuo pipefail

IMAGE="${IMAGE:-pi-remote-runtime:local-test}"
HOST_PORT="${HOST_PORT:-17777}"
CONTAINER="${CONTAINER:-pi-remote-runtime-test-$$}"
SKIP_BUILD="${SKIP_BUILD:-0}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

retry() {
  local tries="$1" delay="$2"
  shift 2
  local i
  for ((i=1; i<=tries; i++)); do
    if "$@"; then return 0; fi
    sleep "$delay"
  done
  return 1
}

curl_body() {
  curl -fsS --max-time 5 "$@"
}

if [[ "$SKIP_BUILD" != "1" ]]; then
  log "Building $IMAGE"
  build_args=()
  if [[ -n "${PI_BRIDGE_PKG:-}" ]]; then
    build_args+=(--build-arg "PI_BRIDGE_PKG=$PI_BRIDGE_PKG")
  elif [[ -f pi-bridge-local.tgz ]]; then
    build_args+=(--build-arg "PI_BRIDGE_PKG=./pi-bridge-local.tgz")
  fi
  docker build "${build_args[@]}" -t "$IMAGE" .
fi

log "Checking installed binaries and runtime user"
docker run --rm "$IMAGE" sh -lc '
  test "$(whoami)" = pi
  command -v pi-remote-runtime
  command -v pi-bridge
  command -v pi
  touch /workspace/runtime-write-test
'

log "Starting runtime container"
cleanup
docker run -d \
  --name "$CONTAINER" \
  -p "127.0.0.1:${HOST_PORT}:7777" \
  -e PI_REMOTE_RUNTIME_ARGS="--in-memory" \
  "$IMAGE" >/dev/null

log "Waiting for health endpoint"
retry 30 1 curl_body "http://127.0.0.1:${HOST_PORT}/health" >/tmp/pi-runtime-health.json \
  || { docker logs "$CONTAINER" >&2 || true; fail "health endpoint did not become ready"; }
grep -q '"ok":true' /tmp/pi-runtime-health.json || fail "health response did not include ok=true"

log "Waiting for proxied workspace API"
retry 30 1 curl_body "http://127.0.0.1:${HOST_PORT}/api/workspace/files" >/tmp/pi-runtime-files.json \
  || { docker logs "$CONTAINER" >&2 || true; fail "workspace API was not reachable through runtime proxy"; }

log "Checking debug diagnostics"
curl_body "http://127.0.0.1:${HOST_PORT}/sessions?debug=1" >/tmp/pi-runtime-sessions.json
grep -q '"bridgePort":7788' /tmp/pi-runtime-sessions.json || fail "debug diagnostics did not report default bridge port"
grep -q 'pi-bridge' /tmp/pi-runtime-sessions.json || fail "debug diagnostics did not report pi-bridge command"

log "Checking token auth on proxied endpoints"
docker rm -f "$CONTAINER" >/dev/null
CONTAINER="${CONTAINER}-auth"
docker run -d \
  --name "$CONTAINER" \
  -p "127.0.0.1:${HOST_PORT}:7777" \
  -e PI_REMOTE_TOKEN="test-token" \
  -e PI_REMOTE_RUNTIME_ARGS="--in-memory" \
  "$IMAGE" >/dev/null

retry 30 1 curl_body "http://127.0.0.1:${HOST_PORT}/health" >/dev/null \
  || { docker logs "$CONTAINER" >&2 || true; fail "auth container health endpoint did not become ready"; }

status=$(curl -sS -o /tmp/pi-runtime-unauth.json -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/api/workspace/files")
[[ "$status" = "401" ]] || fail "expected unauthorized workspace request to return 401, got $status"

retry 30 1 curl_body -H "Authorization: Bearer test-token" "http://127.0.0.1:${HOST_PORT}/api/workspace/files" >/tmp/pi-runtime-auth-files.json \
  || { docker logs "$CONTAINER" >&2 || true; fail "authorized workspace request failed"; }

log "Checking auth JSON decoding and permissions"
docker rm -f "$CONTAINER" >/dev/null
CONTAINER="${CONTAINER}-authjson"
AUTH_B64=$(printf '%s' '{"test-provider":{"type":"oauth","access":"abc"}}' | base64 | tr -d '\n')
docker run -d \
  --name "$CONTAINER" \
  -p "127.0.0.1:${HOST_PORT}:7777" \
  -e PI_AGENT_AUTH_JSON_BASE64="$AUTH_B64" \
  -e PI_REMOTE_RUNTIME_ARGS="--in-memory" \
  "$IMAGE" >/dev/null

retry 30 1 curl_body "http://127.0.0.1:${HOST_PORT}/health" >/dev/null \
  || { docker logs "$CONTAINER" >&2 || true; fail "auth-json container health endpoint did not become ready"; }

docker exec "$CONTAINER" sh -lc '
  test -f /workspace/.pi-agent/auth.json
  test "$(stat -c %a /workspace/.pi-agent/auth.json)" = 600
  grep -q test-provider /workspace/.pi-agent/auth.json
'

log "All local Docker smoke tests passed"
