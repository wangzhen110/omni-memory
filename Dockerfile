# SPDX-License-Identifier: LicenseRef-Omni-Memory-Personal-Use-1.1
# © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory
#
# stdio-first container. The HTTP adapter is loopback-only by design, so a
# published port would not authenticate a LAN client; use the host CLI or an
# SSH tunnel instead of exposing 7788 from the container.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    OMNI_HOME=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /data && chown -R node:node /data

USER node
VOLUME ["/data"]

ENTRYPOINT ["node", "hosts/mcp/bin.mjs"]
