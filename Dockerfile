FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=7777 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates bash tini \
  && rm -rf /var/lib/apt/lists/*

# pi-bridge embeds Pi as a library and serves the chat/workspace HTTP API.
# For local development, drop a packed tarball into the build context and:
#   docker build --build-arg PI_BRIDGE_PKG=./tavon-ai-pi-ai-sdk-bridge-0.0.3.tgz .
# The pinned pi-coding-agent install only provides the `pi` CLI for debugging;
# keep its version in sync with the bridge's pin to avoid session-format skew.
ARG PI_BRIDGE_PKG=@tavon-ai/pi-ai-sdk-bridge@latest
ARG PI_CODING_AGENT_PKG=@earendil-works/pi-coding-agent@0.79.0

WORKDIR /opt/pi-remote-runtime
COPY . .
RUN npm install -g . "${PI_BRIDGE_PKG}" ai "${PI_CODING_AGENT_PKG}" \
  && useradd --create-home --shell /bin/bash pi \
  && mkdir -p /workspace \
  && chown -R pi:pi /workspace /opt/pi-remote-runtime

USER pi
WORKDIR /workspace
EXPOSE 7777

ENTRYPOINT ["tini", "--"]
CMD ["pi-remote-runtime", "--port", "7777"]
