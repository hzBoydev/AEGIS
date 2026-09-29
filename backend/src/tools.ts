import { checkAddressSecurity, type SecurityCheckResult } from "./goplusChecker.js";
import {
  describeNovelty,
  getOnChainIntel,
  getRecentTransactions,
  unknownIntel,
  type OnChainIntel,
} from "./bscscanChecker.js";
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
  /** Tools that executed and returned usable data. */
  succeeded: string[];
  /**
   * Tools that ran but whose data source is not reachable (e.g. the BSC testnet
   * explorer). NOT a failure: the tool answered with an explicit
   * `status: "unavailable"` payload, so the run still counts and the LLM still
   * gets a second round.
   */
  unavailable: string[];
  /** Tools that failed (API down, unknown error). */
  failed: string[];
  /** Text block ready to inject into the second-round prompt. */
  block: string;
}

/** What a single tool executor returns. */
interface ToolOutcome {
  /** JSON payload handed to the LLM. */
  out: string;
  /** True when the payload reports an unreachable data source. */
  unavailable?: boolean;
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
      "The recipient's last 10 transactions (time, in/out direction, counterparty address, BNB amount) to inspect activity patterns and velocity. May return status: 'unavailable' — the BSC testnet explorer is not reachable with a free API plan, in which case the pattern is UNKNOWN, never 'no activity'.",
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
async function runSenderProfile(ctx: ToolContext): Promise<ToolOutcome> {
  const [intel, security] = await Promise.all([
    getOnChainIntel(ctx.sender),
    checkAddressSecurity(ctx.sender),
  ]);

  return {
    out: JSON.stringify({
      address: ctx.sender,
      onChain: {
        txCount: intel.txCount,
        txCountSource: intel.txCountSource,
        sourceNote:
          intel.txCountSource === "rpc_nonce"
            ? "RPC nonce = OUTGOING transactions ONLY; incoming transactions are not counted. NOT the on-chain transaction total."
            : undefined,
        accountProfile: describeNovelty(intel.novelty),
        novelty: intel.novelty,
        balanceBNB:
          intel.balanceBNB !== null
            ? Number(intel.balanceBNB.toFixed(6))
            : null,
        isContract: intel.isContract,
        eip7702Delegated: intel.eip7702Delegated,
        aegisVaultHistory: {
          escrowIn: intel.aegisEscrowIn,
          escrowOut: intel.aegisEscrowOut,
          distinctSenders: intel.aegisDistinctSenders,
          note:
            "Read directly from the AegisVault event log on-chain. Scope: only transfers routed through AEGIS.",
          unavailable: intel.aegisLogsUnavailable,
          windowLimited: intel.aegisWindowLimited,
        },
        unavailable: intel.unavailable,
      },
      goplus: {
        status: security.status,
        flags: security.riskFlags,
        simulated: security.simulated === true,
        note:
          security.status === "unavailable"
            ? "GoPlus is unavailable — treat as UNKNOWN, not safe."
            : security.failedChains && security.failedChains.length > 0
              ? `PARTIAL COVERAGE: chain(s) ${security.failedChains.join(", ")} unreachable — not a full clean bill of health.`
              : undefined,
      },
    }),
  };
}

/**
 * Recipient activity pattern.
 *
 * The BSC testnet explorer is not usable with a free API plan (BscScan V1 is
 * deprecated, Etherscan V2 needs a paid plan for chain 97). This tool therefore
 * degrades to an explicit "unavailable" payload — the same contract GoPlus
 * uses — instead of throwing, so that:
 * - the pipeline stops reporting a failure nobody can fix,
 * - the LLM reads the pattern as UNKNOWN, never as "no activity",
 * - the investigation still runs its second round with the other evidence.
 */
async function runRecipientRecentTxs(ctx: ToolContext): Promise<ToolOutcome> {
  const txs = await getRecentTransactions(ctx.recipient, 10);

  if (txs === null) {
    return {
      unavailable: true,
      out: JSON.stringify({
        status: "unavailable",
        source: "bsc_testnet_explorer",
        note: "The recipient's on-chain transaction history could not be fetched: the BSC testnet explorer is not accessible with a free API plan.",
        interpretation:
          "UNKNOWN activity pattern. Do NOT read this as 'no transactions' and do NOT treat it as a clean wallet. A missing history is not evidence of safety.",
        fallback:
          "Use get_recipient_db_history instead: it shows every AEGIS escrow ever addressed to this recipient (a partial view — only transfers routed through AEGIS).",
      }),
    };
  }

  if (txs.length === 0) {
    return {
      out: JSON.stringify({
        status: "ok",
        note: "This recipient has no recorded transactions on BSC Testnet.",
      }),
    };
  }

  return { out: JSON.stringify({ status: "ok", count: txs.length, transactions: txs }) };
}

function runSenderDbHistory(ctx: ToolContext): ToolOutcome {
  const h = getSenderEscrowHistory(ctx.sender);
  return {
    out: JSON.stringify({
      note:
        "AEGIS internal DATABASE history — NOT on-chain data. This total = the number of escrows via AEGIS, not the number of blockchain transactions.",
      totalEscrow: h.total,
      approved: h.approved,
      rejected: h.rejected,
      otherRecipients: h.otherRecipients,
      recentEscrows: h.recent,
    }),
  };
}

function runRecipientDbHistory(ctx: ToolContext): ToolOutcome {
  const h = getRecipientEscrowHistory(ctx.recipient);
  return {
    out: JSON.stringify({
      note:
        "AEGIS internal DATABASE history — NOT on-chain data. This total = the number of escrows addressed to this address via AEGIS, not the number of blockchain transactions.",
      totalEscrow: h.total,
      approved: h.approved,
      rejected: h.rejected,
      distinctSenders: h.distinctSenders,
      recentEscrows: h.recent,
    }),
  };
}

async function runSingleTool(name: string, ctx: ToolContext): Promise<ToolOutcome> {
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

/**
 * The Advocate's own evidence, plus the structured sender result the pipeline
 * needs for its deterministic sender check.
 *
 * `senderSecurity` is returned separately (not just rendered into `context`)
 * because "is the sender flagged" must not depend on what the LLM did with the
 * text: it drives the final guard.
 */
export interface AdvocateEvidence {
  /** JSON block to inject into the Advocate/Judge prompts. */
  context: string;
  /** GoPlus result for the SENDER — the pipeline's deterministic input. */
  senderSecurity: SecurityCheckResult;
  /** Sender on-chain intel, already fetched — reused to avoid a second scan. */
  senderIntel: OnChainIntel;
}

/**
 * Evidence the Advocate gathers for ITSELF, before it argues.
 *
 * The Advocate used to run with strictly less information than the Investigator:
 * it saw the recipient's evidence but never the sender's. In a hearing whose
 * whole purpose is to stress-test a RELEASE decision, that means the argument
 * against releasing is built blind — it either repeats the Investigator's own
 * facts or invents something.
 *
 * So the pipeline pre-fetches the sender side in code (no extra LLM call, no
 * model-chosen tool call) and hands it to the Advocate. Deterministic, cheap and
 * it makes the adversarial round a real one.
 */
export async function buildAdvocateEvidence(
  ctx: ToolContext
): Promise<AdvocateEvidence> {
  try {
    const [senderIntel, senderSecurity, senderHistory, recipientHistory] =
      await Promise.all([
        getOnChainIntel(ctx.sender),
        checkAddressSecurity(ctx.sender),
        Promise.resolve(getSenderEscrowHistory(ctx.sender)),
        Promise.resolve(getRecipientEscrowHistory(ctx.recipient)),
      ]);

    return {
      senderSecurity,
      senderIntel,
      context: JSON.stringify({
      note:
        "SIDE EVIDENCE COLLECTED BY THE ADVOCATE (not supplied by the Investigator). " +
        "Use it to stress-test the position you are defending. " +
        "A sender that GoPlus flags as malicious is a laundering pattern: a blocked " +
        "party routing funds through the escrow to reach the recipient.",
      sender: {
        address: ctx.sender,
        accountProfile: describeNovelty(senderIntel.novelty),
        txCount: senderIntel.txCount,
        txCountSource: senderIntel.txCountSource,
        balanceBNB:
          senderIntel.balanceBNB !== null
            ? Number(senderIntel.balanceBNB.toFixed(6))
            : null,
        isContract: senderIntel.isContract,
        eip7702Delegated: senderIntel.eip7702Delegated,
        goplus: {
          status: senderSecurity.status,
          flags: senderSecurity.riskFlags,
          simulated: senderSecurity.simulated === true,
          failedChains: senderSecurity.failedChains,
          note:
            senderSecurity.status === "malicious"
              ? "THE SENDER ITSELF IS FLAGGED. This is decisive, not a matter of opinion."
              : undefined,
        },
        aegisEscrowsViaVault: {
          in: senderIntel.aegisEscrowIn,
          out: senderIntel.aegisEscrowOut,
          unavailable: senderIntel.aegisLogsUnavailable,
        },
      },
      aegisDatabaseHistory: {
        note: "AEGIS internal DB — NOT on-chain data.",
        senderSide: {
          total: senderHistory.total,
          approved: senderHistory.approved,
          rejected: senderHistory.rejected,
          distinctRecipients: senderHistory.otherRecipients.length,
        },
        recipientSide: {
          total: recipientHistory.total,
          approved: recipientHistory.approved,
          rejected: recipientHistory.rejected,
          distinctSenders: recipientHistory.distinctSenders,
        },
      },
    }),
    };
  } catch (err) {
    // Never let side-evidence collection break the hearing.
    console.warn(
      `[Advocate] Side evidence unavailable (${err instanceof Error ? err.message : err}).`
    );
    return {
      senderSecurity: {
        status: "unavailable",
        riskFlags: [],
        source: "unavailable",
      },
      senderIntel: unknownIntel(),
      context: JSON.stringify({
        status: "unavailable",
        note: "The Advocate's own side evidence could not be collected. Treat it as UNKNOWN and say so in your argument.",
      }),
    };
  }
}

// ── Bulk execution (parallel, each tool failure-isolated) ─────────────────────
/**
 * Run every tool requested by the LLM, in parallel.
 *
 * Three outcomes are kept strictly apart, because they mean different things
 * to the model:
 * - succeeded   : usable data.
 * - unavailable : the tool ran, but its data source is out of reach (e.g. the
 *                 BSC testnet explorer). The payload says so explicitly and the
 *                 run still counts as executed.
 * - failed      : the tool itself broke. Reported as "FAILED / unknown".
 *
 * Security properties:
 * - Tools ONLY produce additional evidence; they NEVER decide
 *   eligible/confidence (that stays with the LLM + threshold + hard rules).
 * - Neither "unavailable" nor "FAILED" is ever read as safe: both carry an
 *   explicit UNKNOWN note in the prompt.
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
        const outcome = await runSingleTool(name, ctx);
        return { name, ok: true, unavailable: outcome.unavailable === true, out: outcome.out };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          name,
          ok: false,
          unavailable: false,
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
  const unavailable = results
    .filter((r) => r.ok && r.unavailable)
    .map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);

  const block = results
    .map((r) => `=== TOOL RESULT: ${r.name} ===\n${r.out}`)
    .join("\n\n")
    .slice(0, BLOCK_CHAR_LIMIT);

  return { requested, succeeded, unavailable, failed, block };
}
