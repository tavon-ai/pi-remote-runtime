# pi-remote-runtime

Workspace-side runtime image for Pi Remote / Pi-to-Go.

The image bundles:

- `pi` from `@earendil-works/pi-coding-agent`
- `pi-remote-runtime`
- a health endpoint
- a WebSocket RPC proxy to `pi --mode rpc`

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

RPC WebSocket path:

```text
ws://localhost:7777/rpc
```

Use `Authorization: Bearer <PI_REMOTE_TOKEN>` when `PI_REMOTE_TOKEN` is set.

## Docker Hub login

```bash
docker login --username tavonai
```

## Override the supervised command

```bash
docker run --rm -p 7777:7777 tavonai/pi-remote-runtime:latest \
  pi-remote-runtime --port 7777 -- pi --mode rpc
```
