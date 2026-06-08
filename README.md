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

```bash
docker build -t tavonai/pi-remote-runtime:latest .
```

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

## Push

```bash
docker login --username tavonai
docker push tavonai/pi-remote-runtime:latest
```

## Override the supervised command

```bash
docker run --rm -p 7777:7777 tavonai/pi-remote-runtime:latest \
  pi-remote-runtime --port 7777 -- pi --mode rpc
```
