FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=7777 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates bash tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi-remote-runtime
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY bin ./bin
RUN npm install -g . @earendil-works/pi-coding-agent@latest \
  && useradd --create-home --shell /bin/bash pi \
  && mkdir -p /workspace \
  && chown -R pi:pi /workspace /opt/pi-remote-runtime

USER pi
WORKDIR /workspace
EXPOSE 7777

ENTRYPOINT ["tini", "--"]
CMD ["pi-remote-runtime", "--port", "7777", "--", "pi", "--mode", "rpc"]
