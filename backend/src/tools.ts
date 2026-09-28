import { checkAddressSecurity } from "./goplusChecker.js";
import { getOnChainIntel, getRecentTransactions } from "./bscscanChecker.js";
import {
  getSenderEscrowHistory,
  getRecipientEscrowHistory,
} from "./db.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ToolContext {
  /** Escrow sender address (0x...). */
  sender: string;
  /** Escrow recipient address (0x...). */
  recipient: string;
}

export interface ToolDefinition {
  /** Tool name — the only value legally allowed in the LLM's needsData. */
  name: string;
  /** Short description for the prompt catalog. */
  description: string;
}

export interface ToolExecutionResult {
  /** Tool names requested by the LLM (already validated against the catalog). */
  requested: string[];
  /** Tools that executed successfully. */
  succeeded: string[];
  /** Tools that failed (API down, etc). */
  failed: string[];
  /** Text block ready to inject into the second-round prompt. */
  block: string;
}

// ── Tool catalog (source of truth for needsData validation) ───────────────────
export const TOOL_CATALOG: ToolDefinition[] = [
  {
    name: "get_sender_profile",
    description:
      "On-chain profile of the sender (balance, wallet age, transaction count, whether it is a contract) + GoPlus security reputation for the sender address.",
  },
  {
    name: "get_recipient_recent_txs",
    description:
      "The recipient's last 10 transactions (time, in/out direction, counterparty address, BNB amount) to inspect activity patterns and velocity.",
  },
  {
    name: "get_sender_db_history",
    description:
      "AEGIS escrow history for this sender: how many were ever sent, how many were approved/rejected, plus the list of other recipients that were sent to.",
  },
  {
    name: "get_recipient_db_history",
    description:
      "All AEGIS escrows ever addressed to this recipient from various different senders (detects the recipient as a fund pooling hub).",
  },
];

export const TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CATALOG.map((t) => t.name)
);

/**
 * Validate the LLM's `needsData` against the catalog.
 * Names outside the catalog are never executed (injection / hallucination).
 */
export function sanitizeNeedsData(raw: readonly string[]): {
  requested: string[];
  dropped: string[];
} {
  const requested = raw.filter((n) => TOOL_NAMES.has(n));
  const dropped = raw.filter((n) => !TOOL_NAMES.has(n));
  return { requested, dropped };
}

/** Total character limit for the tool block so the second-round prompt stays light. */
const BLOCK_CHAR_LIMIT = 6000;

// ── Per-tool executors ────────────────────────────────────────────────────────
async function runSenderProfile(ctx: ToolContext): Promise<string> {
  const [intel, security] = await Promise.all([
    getOnChainIntel(ctx.sender),
    checkAddressSecurity(ctx.sender),
  ]);

  return JSON.stringify({
    address: ctx.sender,
    onChain: {
      txCount: intel.txCount,
      txCountSource: intel.txCountSource,
      sourceNote:
        intel.txCountSource === "rpc_nonce"
          ? "RPC nonce = OUTGOING transactions ONLY; incoming transactions are not counted. NOT the on-chain transaction total."
          : undefined,
      walletAgeDays:
        intel.walletAgeInDays !== null
          ? Number(intel.walletAgeInDays.toFixed(1))
          : null,
      balanceBNB:
        intel.balanceBNB !== null
          ? Number(intel.balanceBNB.toFixed(6))
          : null,
      isNewWallet: intel.isNewWallet,
      isContract: intel.isContract,
      unavailable: intel.unavailable,
    },
    goplus: {
      status: security.status,
      flags: security.riskFlags,
      note:
        security.status === "unavailable"
          ? "GoPlus is unavailable — treat as UNKNOWN, not safe."
          : undefined,
    },
  });
}

async function runRecipientRecentTxs(ctx: ToolContext): Promise<string> {
  const txs = await getRecentTransactions(ctx.recipient, 10);
  if (txs === null) {
    throw new Error("BscScan txlist is unavailable");
  }
  if (txs.length === 0) {
    return JSON.stringify({
      note: "This recipient has no recorded transactions on BSC Testnet.",
    });
  }
  return JSON.stringify({ count: txs.length, transactions: txs });
}

function runSenderDbHistory(ctx: ToolContext): string {
  const h = getSenderEscrowHistory(ctx.sender);
  return JSON.stringify({
    note:
      "AEGIS internal DATABASE history — NOT on-chain data. This total = the number of escrows via AEGIS, not the number of blockchain transactions.",
    totalEscrow: h.total,
    approved: h.approved,
    rejected: h.rejected,
    otherRecipients: h.otherRecipients,
    recentEscrows: h.recent,
  });
}

function runRecipientDbHistory(ctx: ToolContext): string {
  const h = getRecipientEscrowHistory(ctx.recipient);
  return JSON.stringify({
    note:
      "AEGIS internal DATABASE history — NOT on-chain data. This total = the number of escrows addressed to this address via AEGIS, not the number of blockchain transactions.",
    totalEscrow: h.total,
    approved: h.approved,
    rejected: h.rejected,
    distinctSenders: h.distinctSenders,
    recentEscrows: h.recent,
  });
}

async function runSingleTool(name: string, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "get_sender_profile":
      return runSenderProfile(ctx);
    case "get_recipient_recent_txs":
      return runRecipientRecentTxs(ctx);
    case "get_sender_db_history":
      return runSenderDbHistory(ctx);
    case "get_recipient_db_history":
      return runRecipientDbHistory(ctx);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Bulk execution (parallel, each tool failure-isolated) ─────────────────────
/**
 * Run every tool requested by the LLM, in parallel.
 *
 * Security properties:
 * - Tools ONLY produce additional evidence; they NEVER decide
 *   eligible/confidence (that stays with the LLM + threshold + hard rules).
 * - Tool failures are reported explicitly as "FAILED / unknown"
 *   to the prompt — an API failure is never considered safe.
 * - A total failure still yields a block containing failure markers;
 *   the caller decides whether a second round is worthwhile.
 */
export async function executeTools(
  requested: string[],
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const results = await Promise.all(
    requested.map(async (name) => {
      try {
        const out = await runSingleTool(name, ctx);
        return { name, ok: true, out };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          name,
          ok: false,
          out: JSON.stringify({
            status: "FAILED",
            error: msg,
            note:
              "Tool execution failed. Treat this data as UNKNOWN, not safe.",
          }),
        };
      }
    })
  );

  const succeeded = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);

  const block = results
    .map((r) => `=== TOOL RESULT: ${r.name} ===\n${r.out}`)
    .join("\n\n")
    .slice(0, BLOCK_CHAR_LIMIT);

  return { requested, succeeded, failed, block };
}
