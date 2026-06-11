# pi-remote-runtime

Workspace-side remote runtime image for Pi.

This image runs inside a workspace or container host and exposes a small HTTP
surface that a remote client can connect to. It supervises
[`pi-bridge`](https://github.com/tavon-ai/pi-ai-sdk-bridge) (Pi embedded as a
library behind an AI SDK chat HTTP API) on localhost, authenticates incoming
traffic with `PI_REMOTE_TOKEN`, and reverse-proxies HTTP to the bridge. It
optionally prepares Pi authentication/configuration from environment variables
before startup.

The image bundles:

- `pi-bridge` from `@tavon-ai/pi-ai-sdk-bridge` (the chat path)
- `pi` from `@earendil-works/pi-coding-agent` (CLI for debugging only; pinned
  to the bridge's library version to avoid session-format skew)
- `pi-remote-runtime` (supervisor: auth, health, sessions listing, reverse proxy)

## Endpoints

Served by the runtime itself:

```text
GET /health      # no auth: { ok, pi: <bridge child alive>, lastExit }
GET /healthz     # alias
GET /sessions    # Pi session files (chats); ?debug=1 adds diagnostics
```

Everything else is proxied to `pi-bridge` after bearer-token auth, notably
`POST/GET /api/chat`, `GET/DELETE /api/chat/:id`, and the read-only
`/api/workspace/*` API. Responses stream, and client aborts propagate so the
bridge can cancel an in-flight Pi prompt.

Use `Authorization: Bearer <PI_REMOTE_TOKEN>` when `PI_REMOTE_TOKEN` is set.

## Supervision

The bridge runs in-process with Pi, so a crash takes the chat server down; the
runtime restarts it with exponential backoff (1s..30s) and reports the last
exit in `/health`.

## Image

Docker Hub namespace:

```text
tavonai/pi-remote-runtime
```

## Build locally

For a local-only test image:

```bash
docker build -t tavonai/pi-remote-runtime:latest .
```

To test unpublished bridge changes, pack the bridge into the build context and
point the build-arg at the tarball:

```bash
cd ../pi-ai-sdk-bridge/packages/bridge && pnpm build && pnpm pack --out ../../../pi-remote-runtime/pi-bridge-local.tgz
cd ../../../pi-remote-runtime
docker build --build-arg PI_BRIDGE_PKG=./pi-bridge-local.tgz -t pi-remote-runtime:dev .
```

## Build and push for Fly.io

Fly/Depot may build workspace images on a different CPU architecture than your local machine. Push a multi-platform manifest so `FROM tavonai/pi-remote-runtime:latest` works from Fly builds:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t tavonai/pi-remote-runtime:latest \
  --push .
```

Do not use a plain `docker build` + `docker push` for the published `latest` image unless you intentionally want a single-platform manifest; Fly may fail with `no match for platform in manifest`.

## Run locally

```bash
docker run --rm -p 7777:7777 \
  -e PI_REMOTE_TOKEN=dev-token \
  tavonai/pi-remote-runtime:latest
```

Health check:

```bash
curl http://localhost:7777/health
```

Chat list:

```bash
curl -H "Authorization: Bearer dev-token" http://localhost:7777/api/chat
```

## Provider credentials and model selection

The runtime can receive Pi-compatible OAuth credentials as base64 JSON. It decodes them before starting the bridge:

```bash
PI_CODING_AGENT_DIR=/workspace/.pi-agent
PI_AGENT_AUTH_JSON_BASE64=$(printf '%s' '{"openai-codex":{"type":"oauth","access":"...","refresh":"...","expires":1790000000000,"accountId":"..."}}' | base64)
PI_PROVIDER=openai-codex
PI_MODEL=gpt-5.5
```

At startup, the runtime writes:

```text
$PI_CODING_AGENT_DIR/auth.json
```

with mode `0600`, then starts `pi-bridge`, which reads `PI_PROVIDER`/`PI_MODEL`
directly from the environment.

Accepted auth env aliases:

- `PI_AGENT_AUTH_JSON_BASE64`
- `PI_AUTH_JSON_BASE64`
- `PI_REMOTE_AUTH_JSON_BASE64`

Extra bridge CLI arguments can be injected via (priority order):

- `PI_REMOTE_RUNTIME_ARGS`
- `PI_CLI_ARGS`
- `PI_ARGS`

They are appended to the supervised `pi-bridge` command.

## Sessions

`pi-bridge` persists chats as regular Pi session files keyed by chat id. With
`PI_CODING_AGENT_DIR` set they live under `$PI_CODING_AGENT_DIR/sessions/`;
the runtime's `GET /sessions` scans that directory (plus Pi's home-dir
defaults), so the control plane can list chats without touching the bridge.

## Docker Hub login

```bash
docker login --username tavonai
```

## Override the supervised command

```bash
docker run --rm -p 7777:7777 tavonai/pi-remote-runtime:latest \
  pi-remote-runtime --port 7777 --bridge-port 7788 -- pi-bridge --host 127.0.0.1 --port 7788
```
