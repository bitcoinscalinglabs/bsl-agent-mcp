#!/usr/bin/env bash
# Prepare ipc-cli config + the agent key, verify connectivity, then stay up.
# MCP clients attach sessions via: docker exec -i bsl-agent-mcp node /app/dist/index.js
set -euo pipefail

: "${AGENT_PRIVATE_KEY:?AGENT_PRIVATE_KEY required}"
: "${SUBNET_ID:?SUBNET_ID required}"
: "${PROVIDER_AUTH_TOKEN:=${TOKEN:-}}"
: "${PROVIDER_AUTH_TOKEN:?PROVIDER_AUTH_TOKEN or TOKEN required}"
: "${PROVIDER_PORT:=3030}"
: "${SUBNET_ID2:=}"
: "${URL:=}"
: "${URL2:=}"
: "${GATEWAY_ADDR:=}"
: "${REGISTRY_ADDR:=}"

# Same config.toml the bsl-client generates: btc entry for the parent, fevm
# entries per subnet (ipc-cli reaches the provider over the shared network).
mkdir -p /root/.ipc
cat > /root/.ipc/config.toml <<EOF
keystore_path = "~/.ipc"

[[subnets]]
id = "${SUBNET_ID%/*}"

[subnets.config]
network_type = "btc"
provider_http = "http://127.0.0.1:${PROVIDER_PORT}/api"
auth_token = "$PROVIDER_AUTH_TOKEN"
EOF

append_fevm_subnet() {
  local id="$1" base="$2"
  [ -n "$id" ] && [ -n "$base" ] && [ -n "$GATEWAY_ADDR" ] && [ -n "$REGISTRY_ADDR" ] || return 0
  cat >> /root/.ipc/config.toml <<EOF

[[subnets]]
id = "$id"

[subnets.config]
network_type = "fevm"
provider_http = "${base}${TOKEN:-}"
gateway_addr = "$GATEWAY_ADDR"
registry_addr = "$REGISTRY_ADDR"
EOF
}
append_fevm_subnet "$SUBNET_ID" "$URL"
append_fevm_subnet "$SUBNET_ID2" "$URL2"

ipc-cli wallet import --wallet-type evm --private-key "$AGENT_PRIVATE_KEY" \
  || echo "agent key already in keystore"

# Startup checks — catch the common problems while the user is watching.
if nc -z 127.0.0.1 "$PROVIDER_PORT" 2>/dev/null; then
  echo "check: provider reachable on 127.0.0.1:$PROVIDER_PORT"
else
  echo "WARNING: provider NOT reachable on 127.0.0.1:$PROVIDER_PORT — is the" \
       "bsl-client container running, and was this container started with" \
       "--network container:bsl-client?"
fi
if [ -n "$URL" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
    -H "Authorization: Bearer ${TOKEN:-}" -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$URL" || true)
  if [ "$code" = "200" ]; then
    echo "check: gateway reachable, token accepted"
  else
    echo "WARNING: gateway check failed (HTTP $code) — check TOKEN in bsl.env"
  fi
fi

echo "bsl-agent-mcp ready - attach MCP sessions with:"
echo "  docker exec -i bsl-agent-mcp node /app/dist/index.js"
exec sleep infinity
