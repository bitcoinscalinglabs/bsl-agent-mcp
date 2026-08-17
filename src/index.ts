#!/usr/bin/env node
// MCP server exposing BSL Bitcoin-IPC testnet payments to an AI agent.
// L1 ops go through the local bsl-client container (provider RPC, ipc-cli,
// tunneled bitcoind); subnet reads/transfers go through the public L2 gateways.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FetchRequest, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const execFileP = promisify(execFile);

// Load config from .env at the repo root; variables already set in the
// environment win. Secrets stay out of the MCP client's config this way.
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // no .env file — configuration comes from the environment
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

// Client access key (gateway bearer + provider auth); bsl.env names it TOKEN.
const TOKEN = process.env.API_TOKEN ?? requireEnv("TOKEN");
const AGENT_PRIVATE_KEY = requireEnv("AGENT_PRIVATE_KEY");
const SUBNET_ID = requireEnv("SUBNET_ID");
// bsl.env names it SUBNET_ID2.
const SUBNET2_ID = process.env.SUBNET2_ID ?? process.env.SUBNET_ID2 ?? requireEnv("SUBNET2_ID");
// "local" (inside the bsl-agent-mcp container, sharing the bsl-client network):
// talk to bitcoind directly and run ipc-cli in-process. Default: docker exec
// into the bsl-client container.
const EXEC_LOCAL = process.env.BSL_EXEC === "local";
const BITCOIND_URL = process.env.BITCOIND_URL ?? "http://127.0.0.1:18443";
const URL1 = process.env.URL ?? "https://rpc.testnet.bitcoinscalinglabs.com/";
const URL2 = process.env.URL2 ?? "https://rpc2.testnet.bitcoinscalinglabs.com/";
const PROVIDER_URL = process.env.PROVIDER_URL ?? "http://127.0.0.1:3030/api";
const CONTAINER = process.env.BSL_CONTAINER ?? "bsl-client";
const SPEND_CAP_SATS = BigInt(process.env.SPEND_CAP_SATS ?? "500000"); // 0.005 BTC

const SATS_PER_BTC = 100_000_000n;
const WEI_PER_SAT = 10_000_000_000n; // wBTC has 18 decimals, BTC has 8

function gatewayProvider(url: string): JsonRpcProvider {
  const req = new FetchRequest(url);
  req.setHeader("Authorization", `Bearer ${TOKEN}`);
  return new JsonRpcProvider(req);
}

const subnet1 = gatewayProvider(URL1);
const subnet2 = gatewayProvider(URL2);
const agentWallet = new Wallet(AGENT_PRIVATE_KEY, subnet1);
const AGENT_ADDRESS = agentWallet.address;

function fmtSats(sats: bigint): string {
  const btc = Number(sats) / Number(SATS_PER_BTC);
  return `${sats} sats (${btc} BTC)`;
}

// JSON-RPC call to the bsl-client provider (L1 operations).
async function providerRpc(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(PROVIDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`provider HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`provider ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

async function dockerExec(args: string[]): Promise<string> {
  const { stdout } = await execFileP("docker", ["exec", CONTAINER, ...args], {
    timeout: 120_000,
  });
  return stdout;
}

// Run ipc-cli: in-process when local, otherwise inside the bsl-client container.
async function ipcCli(args: string[]): Promise<string> {
  if (EXEC_LOCAL) {
    const { stdout } = await execFileP("ipc-cli", args, { timeout: 120_000 });
    return stdout;
  }
  return dockerExec(["ipc-cli", ...args]);
}

// L1 wallet balances in BTC, from bitcoind (direct when local, else via the container).
async function l1Balances(): Promise<{ trusted: number; pending: number }> {
  let out: string;
  if (EXEC_LOCAL) {
    const { RPC_USER, RPC_PASS, WALLET_NAME } = process.env;
    const res = await fetch(`${BITCOIND_URL}/wallet/${WALLET_NAME}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64")}`,
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "getbalances", params: [] }),
    });
    out = await res.text();
  } else {
    out = await dockerExec([
      "sh",
      "-c",
      'curl -s --user "$RPC_USER:$RPC_PASS" -d \'{"jsonrpc":"1.0","id":1,"method":"getbalances","params":[]}\' "http://127.0.0.1:18443/wallet/$WALLET_NAME"',
    ]);
  }
  const parsed = JSON.parse(out);
  if (parsed.error) throw new Error(`bitcoind: ${JSON.stringify(parsed.error)}`);
  return { trusted: parsed.result.mine.trusted, pending: parsed.result.mine.untrusted_pending };
}

function btcToSats(btc: number): bigint {
  return BigInt(Math.round(btc * Number(SATS_PER_BTC)));
}

// Policy gate shared by every money-moving tool.
function policyBlock(amountSats: bigint, confirmed: boolean, action: string): string | null {
  if (amountSats <= 0n) return `Invalid amount: ${amountSats} sats.`;
  if (amountSats > SPEND_CAP_SATS && !confirmed) {
    return (
      `POLICY: ${action} of ${fmtSats(amountSats)} exceeds the spending cap of ` +
      `${fmtSats(SPEND_CAP_SATS)}. Not executed. Ask the user for explicit approval ` +
      `of this exact amount and recipient; only after they approve, retry with confirmed=true.`
    );
  }
  return null;
}

// Known payees: demo merchants the user can name instead of pasting an address.
// Keys for these throwaway accounts: testnet-deploy/secrets/demo-<payee>.key
const PAYEES: Record<string, { display: string; address: string; subnet: 1 | 2 }> = {
  "rolling-scones": {
    display: "The Rolling Scones (restaurant, subnet1)",
    address: "0x7a8CcA5A4563055C572eD75f1cba92f6677a1FA8",
    subnet: 1,
  },
  "zeppelin-deliveries": {
    display: "Zeppelin Deliveries (courier, subnet2)",
    address: "0xbD80BB6533214D570F35F0229124b0E179E9475E",
    subnet: 2,
  },
};

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true };
}

const server = new McpServer({ name: "bsl-agent-mcp", version: "0.1.0" });

server.registerTool(
  "wallet_status",
  {
    title: "Wallet status",
    description:
      "Balances of the user-owned wallet this server operates: L1 Bitcoin (testnet BTC), and wBTC " +
      "on subnet1 and subnet2. Also reports the wallet's address and the spending cap.",
    inputSchema: {},
  },
  async () => {
    try {
      const [bal1, bal2] = await Promise.all([
        subnet1.getBalance(AGENT_ADDRESS),
        subnet2.getBalance(AGENT_ADDRESS),
      ]);
      let l1 = "unavailable (is the bsl-client container running?)";
      try {
        const b = await l1Balances();
        l1 = `${b.trusted} BTC (confirmed), ${b.pending} BTC pending`;
      } catch {
        // container may be down; L2 balances are still useful
      }
      return text(
        [
          `Agent address (both subnets): ${AGENT_ADDRESS}`,
          `L1 Bitcoin wallet: ${l1}`,
          `subnet1 wBTC: ${formatEther(bal1)}`,
          `subnet2 wBTC: ${formatEther(bal2)}`,
          `Spending cap per operation: ${fmtSats(SPEND_CAP_SATS)} (above this, user approval is required)`,
        ].join("\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "deposit_btc",
  {
    title: "Deposit BTC into subnet1",
    description:
      "Move BTC from the agent's L1 Bitcoin wallet into subnet1, where it becomes wBTC at the " +
      "agent's address. This is an L1 Bitcoin transaction; the wBTC arrives after the deposit " +
      "is processed (typically 1-2 minutes on the testnet). Amount is in satoshis.",
    inputSchema: {
      amount_sats: z.number().int().positive().describe("Amount in satoshis (1 BTC = 100,000,000 sats)"),
      confirmed: z
        .boolean()
        .optional()
        .describe("Set true only after the user explicitly approved this over-cap deposit"),
    },
  },
  async ({ amount_sats, confirmed }) => {
    try {
      const amount = BigInt(amount_sats);
      const block = policyBlock(amount, confirmed ?? false, "Deposit");
      if (block) return text(block);
      // Pre-check the L1 balance: the provider reports this case as an opaque internal error.
      const FEE_HEADROOM_SATS = 5_000n;
      const trustedSats = btcToSats((await l1Balances()).trusted);
      if (amount + FEE_HEADROOM_SATS > trustedSats) {
        return text(
          `Insufficient L1 funds: deposit of ${fmtSats(amount)} plus ~${FEE_HEADROOM_SATS} sats ` +
            `fee headroom exceeds the L1 wallet balance of ${fmtSats(trustedSats)}. ` +
            `Not submitted. Choose a smaller amount.`
        );
      }
      const result = await providerRpc("fundsubnet", {
        subnet_id: SUBNET_ID,
        amount: amount_sats,
        address: AGENT_ADDRESS,
      });
      return text(
        `Deposit submitted: ${fmtSats(amount)} from the L1 wallet to ${AGENT_ADDRESS} on subnet1.\n` +
          `Provider response: ${JSON.stringify(result)}\n` +
          `Check wallet_status in ~1-2 minutes for the wBTC to arrive.`
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "pay",
  {
    title: "Pay wBTC to an address",
    description:
      "Send wBTC from the agent's address on subnet1 to a recipient. Recipient is either a payee " +
      "from the address book (see address_book) or a to_address + target_subnet given by the user " +
      "- never invent an address. If the target subnet is 1 this is an ordinary subnet1 transfer " +
      "(settles in seconds). If it is 2 this is a cross-subnet transfer: it debits subnet1 " +
      "immediately and is delivered on subnet2 after subnet1's next Bitcoin checkpoint " +
      "(~2 minutes). Amount is in satoshis.",
    inputSchema: {
      payee: z
        .enum(Object.keys(PAYEES) as [string, ...string[]])
        .optional()
        .describe("Payee name from the address book (alternative to to_address)"),
      to_address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .optional()
        .describe("Recipient EVM address (from the user; omit when payee is given)"),
      target_subnet: z
        .union([z.literal(1), z.literal(2)])
        .optional()
        .describe("1 = same-subnet payment, 2 = cross-subnet (omit when payee is given)"),
      amount_sats: z.number().int().positive().describe("Amount in satoshis"),
      confirmed: z
        .boolean()
        .optional()
        .describe("Set true only after the user explicitly approved this over-cap payment"),
    },
  },
  async ({ payee, to_address, target_subnet, amount_sats, confirmed }) => {
    try {
      let recipient: string;
      if (payee !== undefined) {
        if (to_address !== undefined || target_subnet !== undefined)
          return text("Give either payee, or to_address + target_subnet - not both.");
        ({ address: recipient, subnet: target_subnet } = PAYEES[payee]);
      } else {
        if (to_address === undefined || target_subnet === undefined)
          return text("Give either payee, or to_address + target_subnet.");
        recipient = to_address;
      }
      const who = payee ? `${PAYEES[payee].display} at ${recipient}` : recipient;
      const amount = BigInt(amount_sats);
      const block = policyBlock(amount, confirmed ?? false, `Payment to ${who}`);
      if (block) return text(block);

      if (target_subnet === 1) {
        const tx = await agentWallet.sendTransaction({
          to: recipient,
          value: amount * WEI_PER_SAT,
        });
        const receipt = await tx.wait();
        return text(
          `Paid ${fmtSats(amount)} to ${who} on subnet1.\n` +
            `Tx hash: ${tx.hash} (block ${receipt?.blockNumber}).`
        );
      }

      const out = await ipcCli([
        "cross-msg",
        "transfer",
        "--source-subnet",
        SUBNET_ID,
        "--destination-subnet",
        SUBNET2_ID,
        "--source-address",
        AGENT_ADDRESS,
        "--destination-address",
        recipient,
        String(amount_sats),
      ]);
      return text(
        `Cross-subnet payment submitted: ${fmtSats(amount)} to ${who} on subnet2.\n` +
          `ipc-cli output: ${out.trim()}\n` +
          `The subnet1 balance drops immediately; delivery on subnet2 happens after subnet1's ` +
          `next Bitcoin checkpoint. Use payment_receipt to get the anchoring Bitcoin transaction.`
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "address_book",
  {
    title: "Address book",
    description:
      "List the known payees the agent can pay by name, with their address, subnet, and current " +
      "wBTC balance. Recipients not listed here must have their address supplied by the user.",
    inputSchema: {},
  },
  async () => {
    try {
      const lines = await Promise.all(
        Object.entries(PAYEES).map(async ([name, p]) => {
          const bal = await (p.subnet === 1 ? subnet1 : subnet2).getBalance(p.address);
          return `${name}: ${p.display}\n  ${p.address}  balance: ${formatEther(bal)} wBTC`;
        })
      );
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "check_balance",
  {
    title: "Check balance of any account",
    description:
      "wBTC balance of any account on both subnets - a payee from the address book or any EVM " +
      "address (e.g. to confirm a recipient got paid). Give exactly one of payee or address.",
    inputSchema: {
      payee: z
        .enum(Object.keys(PAYEES) as [string, ...string[]])
        .optional()
        .describe("Payee name from the address book"),
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .optional()
        .describe("Any EVM address (alternative to payee)"),
    },
  },
  async ({ payee, address }) => {
    try {
      if ((payee === undefined) === (address === undefined))
        return text("Give exactly one of payee or address.");
      const target = payee !== undefined ? PAYEES[payee].address : address!;
      const label = payee !== undefined ? `${PAYEES[payee].display} at ${target}` : target;
      const [bal1, bal2] = await Promise.all([
        subnet1.getBalance(target),
        subnet2.getBalance(target),
      ]);
      return text(
        [
          `Balances of ${label}:`,
          `  subnet1 wBTC: ${formatEther(bal1)}`,
          `  subnet2 wBTC: ${formatEther(bal2)}`,
        ].join("\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "payment_receipt",
  {
    title: "Payment receipt (Bitcoin anchor)",
    description:
      "Fetch the Bitcoin-anchored checkpoint that finalizes subnet1 activity: the checkpoint's L2 " +
      "height, and the Bitcoin block height and transaction id that anchor it. Optionally pass " +
      "min_l2_height (e.g. the epoch printed by a cross-subnet payment, or the block of a subnet1 " +
      "tx) to get the FIRST checkpoint at or after that height - the one that anchored the payment. " +
      "If that checkpoint doesn't exist yet, the payment is not anchored yet: wait and retry.",
    inputSchema: {
      min_l2_height: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Find the first checkpoint with L2 height >= this; omit for the latest checkpoint"),
    },
  },
  async ({ min_l2_height }) => {
    try {
      type Checkpoint = {
        checkpoint_number: number;
        checkpoint_height: number;
        block_height: number;
        txid: string;
        batch_transfer_txid: string | null;
      };
      const last = (await providerRpc("getsubnetcheckpoint", { subnet_id: SUBNET_ID })) as Checkpoint | null;
      if (!last) return text("No checkpoint committed yet for subnet1.");

      let cp = last;
      if (min_l2_height !== undefined) {
        if (last.checkpoint_height < min_l2_height) {
          return text(
            `Not anchored yet: latest checkpoint #${last.checkpoint_number} covers subnet1 up to ` +
              `L2 height ${last.checkpoint_height}, before ${min_l2_height}. Retry in ~1-2 minutes.`
          );
        }
        // Walk back to the first checkpoint at/after min_l2_height.
        while (cp.checkpoint_number > 0) {
          const prev = (await providerRpc("getsubnetcheckpoint", {
            subnet_id: SUBNET_ID,
            number: cp.checkpoint_number - 1,
          })) as Checkpoint | null;
          if (!prev || prev.checkpoint_height < min_l2_height) break;
          cp = prev;
        }
      }

      return text(
        [
          `Checkpoint #${cp.checkpoint_number} (subnet1):`,
          `  Covers subnet1 up to L2 height: ${cp.checkpoint_height}`,
          `  Anchored on Bitcoin at block ${cp.block_height}, txid: ${cp.txid}`,
          // batch_transfer_txid is stored under the wrong key upstream (known bug).
          ...(cp.batch_transfer_txid
            ? [`  Cross-subnet transfer batch txid on Bitcoin: ${cp.batch_transfer_txid}`]
            : []),
          ``,
          `Anyone can verify this on the Bitcoin chain - the agent cannot forge it.`,
        ].join("\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "subnet_info",
  {
    title: "Subnet info",
    description:
      "Current state of a subnet as reconstructed from Bitcoin by the local monitor: validator " +
      "committee, threshold, the committee's Bitcoin multisig address, and the latest checkpoint number.",
    inputSchema: {
      subnet: z.union([z.literal(1), z.literal(2)]).describe("Which subnet to inspect"),
    },
  },
  async ({ subnet }) => {
    try {
      type SubnetState = {
        id: string;
        committee_number: number;
        committee: {
          threshold: number;
          validators: { subnet_address: string; power: number; collateral: number }[];
          multisig_address: string;
        };
        last_checkpoint_number: number | null;
        killed: unknown;
      };
      const id = subnet === 1 ? SUBNET_ID : SUBNET2_ID;
      const s = (await providerRpc("getsubnet", { subnet_id: id })) as SubnetState | null;
      if (!s) return text(`Subnet ${id} not found.`);
      const vals = s.committee.validators;
      return text(
        [
          `Subnet: ${s.id}`,
          `Committee #${s.committee_number}: ${vals.length} validators, signing threshold ${s.committee.threshold}`,
          `Committee Bitcoin multisig: ${s.committee.multisig_address}`,
          `Last checkpoint committed to Bitcoin: #${s.last_checkpoint_number ?? "none"}`,
          `Validators:`,
          ...vals.map(
            (v) => `  ${v.subnet_address}  power=${v.power}  collateral=${fmtSats(BigInt(v.collateral))}`
          ),
        ].join("\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `bsl-agent-mcp ready: agent=${AGENT_ADDRESS} cap=${SPEND_CAP_SATS} sats provider=${PROVIDER_URL}`
);
