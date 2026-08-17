# MCP server image. Runs next to the bsl-client container and shares its
# network (--network container:bsl-client), so the provider (:3030) and the
# bitcoind tunnel (:18443) are reachable on localhost. Based on the bsl-client
# image for its ipc-cli binary (cross-subnet transfers).

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc && npm prune --omit=dev

FROM ghcr.io/bitcoinscalinglabs/bsl-client:testnet
COPY --from=node:20-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/mcp-entrypoint.sh
RUN chmod +x /usr/local/bin/mcp-entrypoint.sh
ENV BSL_EXEC=local
ENTRYPOINT ["/usr/local/bin/mcp-entrypoint.sh"]
