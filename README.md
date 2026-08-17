# bsl-agent-mcp

MCP server that lets an AI agent (Claude Desktop, Claude Code, or any MCP
client) operate a user-owned wallet on the Bitcoin-IPC testnet: deposit L1 BTC
into subnet1, pay wBTC within subnet1 or across to subnet2, and fetch the
Bitcoin-anchored receipt for any payment. The agent never holds keys — it can
only request operations; the server signs locally and refuses any deposit or
payment above `SPEND_CAP_SATS` until the user explicitly approves it
(`confirmed=true`).

> **Disclaimer:** this code is not audited and is meant for testnet use only.
> Do not use it with mainnet funds or keys that control real value.

## Tools

| Tool | What it does |
|------|--------------|
| `wallet_status` | L1 BTC balance + wBTC balances on subnet1/subnet2 + spending cap |
| `deposit_btc` | L1 BTC → wBTC at the agent's address on subnet1 |
| `pay` | wBTC to an address-book payee or user-supplied address; same-subnet (seconds) or subnet1→subnet2 (next checkpoint) |
| `address_book` | Known payees with address, subnet, and live wBTC balance |
| `check_balance` | wBTC balance of any account (payee or raw address) on both subnets |
| `payment_receipt` | The checkpoint anchoring a payment: Bitcoin block height + txid |
| `subnet_info` | Committee, threshold, multisig address, latest checkpoint of a subnet |

## Requirements

A running `bsl-client` container — the public image is
`ghcr.io/bitcoinscalinglabs/bsl-client:testnet` — with its `bsl.env`
configuration file, which must also contain `AGENT_PRIVATE_KEY` (the EVM key
the server pays from).

## Run with Docker

The image runs next to `bsl-client` and shares its network; the entrypoint
generates the ipc-cli config, imports `AGENT_PRIVATE_KEY`, runs connectivity
checks, and idles.

```bash
docker build -t ghcr.io/bitcoinscalinglabs/bsl-agent-mcp:testnet .

docker run -d --env-file ./bsl.env \
  --network container:bsl-client \
  --name bsl-agent-mcp \
  ghcr.io/bitcoinscalinglabs/bsl-agent-mcp:testnet
docker logs bsl-agent-mcp   # should end with "bsl-agent-mcp ready"
```

Claude Desktop attaches MCP sessions to the standing container:

```json
{
  "mcpServers": {
    "bsl-payments": {
      "command": "docker",
      "args": ["exec", "-i", "bsl-agent-mcp", "node", "/app/dist/index.js"]
    }
  }
}
```

## Run from source (development)

Node.js ≥ 20. The `bsl-client` container must publish the provider port
(`-p 127.0.0.1:3030:3030`) and have the agent key imported once:

```bash
docker exec bsl-client ipc-cli wallet import --wallet-type evm --private-key <key>

npm install && npm run build
cp .env.example .env        # fill in
```

Claude Desktop config: `"command": "node"`,
`"args": ["/ABS/PATH/bsl-agent-mcp/dist/index.js"]`. Configuration comes from
the repo's `.env`; an `env` block in the Desktop config takes precedence.

## Configuration

| Var | Required | Meaning |
|-----|----------|---------|
| `API_TOKEN` (or `TOKEN`) | yes | Access key for the L2 gateways and the bsl-client provider |
| `AGENT_PRIVATE_KEY` | yes | EVM key the server pays from (holds wBTC) |
| `SUBNET_ID` / `SUBNET2_ID` | yes | Subnet ids (`SUBNET_ID2` also accepted) |
| `URL` / `URL2` | no | Gateway RPC endpoints (default: BSL testnet gateways) |
| `PROVIDER_URL` | no | bsl-client provider (default `http://127.0.0.1:3030/api`) |
| `BSL_CONTAINER` | no | Container name for `docker exec` in from-source mode (default `bsl-client`) |
| `SPEND_CAP_SATS` | no | Per-operation cap; above it, user approval required (default 500000) |

## Notes

- Amounts are satoshis everywhere (1 BTC = 100,000,000 sats); wBTC has 18
  decimals and the server converts internally.
- Recipients are either payees from the built-in address book or addresses
  supplied by the user; the agent is instructed never to invent an address.
