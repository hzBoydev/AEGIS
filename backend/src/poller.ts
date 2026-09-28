import { formatEther } from "viem";
import { bscTestnet } from "viem/chains";
import { publicClient, walletClient, config, account } from "./config.js";
import { AEGIS_VAULT_ABI } from "./abi.js";
import { runSecurityPipeline } from "./securityPipeline.js";
import { warmupOllama } from "./aiAnalyzer.js";
import {
  saveDecision,
  getDecisionByEscrowId,
  finalizeHumanDecision,
} from "./db.js";
import { publish } from "./streamBus.js";

const contractAddress = config.CONTRACT_ADDRESS;

// ── De-duplication guard ──────────────────────────────────────────────────────
// Prevents double-processing if an event fires AND the fallback poller catches
// the same escrow within the same session.
const processingOrDone = new Set<string>();

// Escrows deferred because the contract is paused — used to avoid spamming notifications.
const pausedDeferred = new Set<string>();

// ── Shared: submit fulfillVerification on-chain ───────────────────────────────
/**
 * Truncate `reason` so it stays within the contract limit (MAX_REASON_BYTES).
 * Truncated on a UTF-8 code point boundary so no partial bytes are produced.
 */
function truncateReason(reason: string, maxBytes: number): string {
  if (Buffer.byteLength(reason, "utf8") <= maxBytes) return reason;
  const sliced = Buffer.from(reason, "utf8").subarray(0, maxBytes);
  const decoded = new TextDecoder("utf-8").decode(sliced);
  return decoded.replace(/�+$/, "");
}

const MAX_REASON_FALLBACK_BYTES = 1024;
let maxReasonBytesCache: number | undefined;

async function readMaxReasonBytes(): Promise<number> {
  if (maxReasonBytesCache !== undefined) return maxReasonBytesCache;
  try {
    const value = await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "MAX_REASON_BYTES",
    });
    maxReasonBytesCache = Number(value as bigint);
  } catch {
    maxReasonBytesCache = MAX_REASON_FALLBACK_BYTES;
  }
  return maxReasonBytesCache;
}

export async function submitFulfillment(
  escrowId: `0x${string}`,
  eligible: boolean,
  reason: string
): Promise<string> {
  console.log(`\n   Submitting decision to smart contract...`);

  const maxBytes = await readMaxReasonBytes();
  const safeReason = truncateReason(reason, maxBytes);
  if (safeReason !== reason) {
    console.warn(
      `   ⚠️ Reason truncated by ${Buffer.byteLength(reason, "utf8") - Buffer.byteLength(safeReason, "utf8")} B` +
        ` (on-chain limit: ${maxBytes} B)`
    );
  }

  try {
    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "fulfillVerification",
      args: [escrowId, eligible, safeReason],
      chain: bscTestnet,
      account,
    });
    console.log(`   ✅ Transaction submitted: ${txHash}`);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`   ✅ Confirmed on-chain.`);
    return txHash;
  } catch (err) {
    // Contract revert EscrowTimeout: the escrow is past ESCROW_TIMEOUT and has
    // already been (or is being) claimed by the sender via claimExpired().
    if (isEscrowTimeoutError(err)) {
      throw new Error(
        `Escrow has expired (past ESCROW_TIMEOUT) — the funds have been / will be returned to the sender via claimExpired().`
      );
    }
    throw err;
  }
}

function isEscrowTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; shortMessage?: string; message?: string };
  const haystack = `${e.name ?? ""} ${e.shortMessage ?? ""} ${e.message ?? ""}`;
  return (
    haystack.includes("EscrowTimeout") ||
    haystack.toLowerCase().includes("escrowtimeout")
  );
}

// ── Shared: claim an expired escrow → funds returned to the sender ─────────
export async function submitExpiredClaim(
  escrowId: `0x${string}`
): Promise<string> {
  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: AEGIS_VAULT_ABI,
    functionName: "claimExpired",
    args: [escrowId],
    chain: bscTestnet,
    account,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`   ⏳ Escrow expired — funds returned to the sender: ${txHash}`);
  return txHash;
}

async function isEscrowExpired(escrowId: `0x${string}`): Promise<boolean> {
  try {
    return (await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "isExpired",
      args: [escrowId],
    })) as boolean;
  } catch {
    return false; // legacy contract without the expiry feature
  }
}

/** True when the owner has enabled the emergency pause (submit/fulfill blocked). */
async function isContractPaused(): Promise<boolean> {
  try {
    return (await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "paused",
    })) as boolean;
  } catch {
    return false; // legacy contract without the pause feature
  }
}

// ── Shared: ESCROW_TIMEOUT from the contract (cached) ──────────────────────────
// Null = legacy contract (no ESCROW_TIMEOUT) → do not assume expiry.
let escrowTimeoutSecCache: number | null | undefined;

async function readEscrowTimeoutSec(): Promise<number | null> {
  if (escrowTimeoutSecCache !== undefined) return escrowTimeoutSecCache;
  try {
    const value = await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "ESCROW_TIMEOUT",
    });
    escrowTimeoutSecCache = Number(value as bigint);
    console.log(`⏳ [Escrow] ESCROW_TIMEOUT = ${escrowTimeoutSecCache}s`);
  } catch {
    console.warn(
      `⏳ [Escrow] The contract has no ESCROW_TIMEOUT (older build?) — the expiry feature is disabled.`
    );
    escrowTimeoutSecCache = null;
  }
  return escrowTimeoutSecCache;
}

// ── Core: process a single escrow by ID ──────────────────────────────────────
async function processEscrow(
  escrowId: `0x${string}`,
  trigger: "event" | "poll"
) {
  if (processingOrDone.has(escrowId)) {
    console.log(`[${trigger.toUpperCase()}] Skipping already-processed: ${escrowId.slice(0, 10)}...`);
    return;
  }

  // Already in the DB (final / pending_human) — do not reprocess after a restart.
  const existing = getDecisionByEscrowId(escrowId) as
    | { status?: string; tx_hash?: string | null }
    | undefined;
  if (existing && (existing.tx_hash || existing.status === "pending_human")) {
    console.log(
      `[${trigger.toUpperCase()}] Skipping known decision (status=${existing.status ?? "final"}): ${escrowId.slice(0, 10)}...`
    );
    processingOrDone.add(escrowId);
    return;
  }

  processingOrDone.add(escrowId);

  console.log(`\n>> [${trigger.toUpperCase()}] Processing escrow: ${escrowId}`);

  try {
    // ── Guard: the contract is PAUSED (emergency mode) ────────────────────────
    // Do not waste the LLM call — the fulfillVerification tx would revert anyway.
    // Remove from processingOrDone so the fallback poll retries after unpause.
    if (await isContractPaused()) {
      processingOrDone.delete(escrowId);
      if (!pausedDeferred.has(escrowId)) {
        pausedDeferred.add(escrowId);
        console.log(
          `[${trigger.toUpperCase()}] Deferred: the contract is paused (emergency mode).`
        );
        publish({
          escrowId,
          phase: "escrow",
          status: "fail",
          label: "Contract is paused",
          detail:
            "The decision is deferred until unpause — users can emergencyWithdraw while paused.",
          data: { paused: true },
        });
      }
      return;
    }
    pausedDeferred.delete(escrowId);

    // ── Fetch escrow data from contract ───────────────────────────────────────
    const escrowData = await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "getEscrowData",
      args: [escrowId],
    }) as readonly [string, string, bigint, number, bigint];
    const [sender, recipient, amount, status, createdAt] = escrowData;

    // ── Guard: the escrow is already final / expired on-chain ─────────────────
    // Status: 0 PENDING, 1 COMPLETED, 2 REVERTED, 3 EXPIRED
    if (Number(status) !== 0) {
      console.log(
        `[${trigger.toUpperCase()}] Skip: the escrow is already final on-chain (status=${status}).`
      );
      processingOrDone.add(escrowId);
      return;
    }

    const timeoutSec = await readEscrowTimeoutSec();
    if (
      timeoutSec !== null &&
      Math.floor(Date.now() / 1000) >= Number(createdAt) + timeoutSec
    ) {
      console.log(
        `[${trigger.toUpperCase()}] Escrow expired — auto-claiming the funds back to the sender.`
      );
      let claimTx: string | undefined;
      try {
        claimTx = await submitExpiredClaim(escrowId);
      } catch (err) {
        console.warn(
          `   ⚠️ Auto-claimExpired failed:`,
          err instanceof Error ? err.message : err
        );
      }
      publish({
        escrowId,
        phase: "escrow",
        status: "fail",
        label: "Escrow expired",
        detail: claimTx
          ? `Past ESCROW_TIMEOUT — funds returned to the sender. ${claimTx}`
          : "Past ESCROW_TIMEOUT — the funds can be claimed back by the sender.",
        data: { ...(claimTx ? { claimTx } : {}), expired: true },
      });
      processingOrDone.add(escrowId);
      return;
    }

    const amountBNB = Number(formatEther(amount));

    // Double-check after the first await: a poller restart may overlap.
    const midFlight = getDecisionByEscrowId(escrowId) as
      | { status?: string; tx_hash?: string | null }
      | undefined;
    if (midFlight && (midFlight.tx_hash || midFlight.status === "pending_human")) {
      console.log(
        `[${trigger.toUpperCase()}] Decision appeared mid-flight — skip: ${escrowId.slice(0, 10)}...`
      );
      return;
    }

    console.log(`   Sender    : ${sender}`);
    console.log(`   Recipient : ${recipient}`);
    console.log(`   Amount    : ${amountBNB} BNB`);
    publish({
      escrowId,
      phase: "escrow",
      status: "start",
      label: `New escrow ${amountBNB} BNB`,
      detail: `from ${sender} → ${recipient}`,
      data: { sender, recipient, amountBNB },
    });

    // ── Run AI security pipeline ───────────────────────────────────────────────
    const decision = await runSecurityPipeline(sender, recipient, amountBNB, escrowId);

    console.log(
      `\n[Final]   eligible=${decision.eligible} risk=${decision.riskLevel} decidedBy=${decision.decidedBy}` +
        (decision.needsHuman ? " needsHuman=true" : "")
    );

    // ── Human-in-the-loop: HOLD — do NOT submit on-chain ──────────────────────
    if (decision.needsHuman) {
      saveDecision({
        escrowId,
        sender,
        recipient,
        amount: amountBNB.toString(),
        eligible: decision.eligible,
        confidence: decision.confidence,
        reasoning: decision.reason,
        riskLevel: decision.riskLevel,
        decidedBy: "human_review",
        riskFlags: decision.evidence.security.riskFlags,
        toolsUsed: decision.toolsUsed,
        debate: decision.debate,
        status: "pending_human",
        ...(decision.humanReason !== undefined
          ? { humanReason: decision.humanReason }
          : {}),
      });
      console.log(`   ⏸ Held for human review (not on-chain yet).\n`);
      // processingOrDone stays filled — the poller must not reprocess until the vote.
      return;
    }

    // ── Submit decision to smart contract ─────────────────────────────────────
    const txHash = await submitFulfillment(escrowId, decision.eligible, decision.reason);

    // ── Persist to database ───────────────────────────────────────────────────
    saveDecision({
      escrowId,
      sender,
      recipient,
      amount: amountBNB.toString(),
      eligible: decision.eligible,
      confidence: decision.confidence,
      reasoning: decision.reason,
      riskLevel: decision.riskLevel,
      decidedBy: decision.decidedBy,
      riskFlags: decision.evidence.security.riskFlags,
      txHash,
      toolsUsed: decision.toolsUsed,
      debate: decision.debate,
      status: "final",
    });

    console.log(`   Saved to database.\n`);
    publish({
      escrowId,
      phase: "escrow",
      status: "done",
      label: "Confirmed on-chain",
      detail: txHash,
      data: { txHash },
    });
  } catch (err) {
    console.error(
      `   ❌ Failed to process escrow ${escrowId}:`,
      err instanceof Error ? err.message : err
    );
    publish({
      escrowId,
      phase: "escrow",
      status: "fail",
      label: "Escrow processing failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    // Keep in processingOrDone to prevent infinite retry loop
  }
}

// ── Human vote: finalize pending_human → on-chain ───────────────────────────
export async function applyHumanVote(
  escrowId: string,
  approve: boolean
): Promise<{ txHash: string }> {
  const { getPendingHumanByEscrowId } = await import("./db.js");
  const row = getPendingHumanByEscrowId(escrowId);
  if (!row) {
    throw new Error("No pending human escrow for this id");
  }

  const aiRec = row.eligible === 1 ? "RELEASE" : "REJECT";
  const voteLabel = approve ? "RELEASE" : "REJECT";

  // ── The escrow is past ESCROW_TIMEOUT → the vote cannot land on-chain ───────
  // Return the funds to the sender via claimExpired() so the vote is still "closed out".
  if (await isEscrowExpired(escrowId as `0x${string}`)) {
    const claimTx = await submitExpiredClaim(escrowId as `0x${string}`);
    const expiredReason =
      `The escrow has expired (past ESCROW_TIMEOUT) — funds are returned to the sender. ` +
      `The human vote "${voteLabel}" was not executed on-chain.`;

    const ok = finalizeHumanDecision({
      escrowId,
      humanVote: approve,
      humanReason: row.human_reason ?? "escrow expired",
      finalReason: expiredReason,
      decidedBy: "human",
      txHash: claimTx,
    });
    if (!ok) {
      throw new Error("Failed to update the DB after claimExpired (it may already be finalized)");
    }

    publish({
      escrowId,
      phase: "human",
      status: "fail",
      label: "Escrow expired — the vote does not apply",
      detail: expiredReason,
      data: { humanVote: approve, claimTx },
    });
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "RETURNED (escrow expired)",
      detail: expiredReason,
      data: { eligible: false, decidedBy: "expired", claimTx },
    });

    return { txHash: claimTx };
  }

  const finalReason =
    `Human decision: ${voteLabel}. ` +
    `AI recommendation: ${aiRec} (confidence ${(row.confidence * 100).toFixed(0)}%). ` +
    (row.human_reason ? `Hold reason: ${row.human_reason} ` : "") +
    row.reasoning;

  const txHash = await submitFulfillment(
    escrowId as `0x${string}`,
    approve,
    finalReason
  );

  const ok = finalizeHumanDecision({
    escrowId,
    humanVote: approve,
    humanReason: row.human_reason ?? "vote manual",
    finalReason,
    decidedBy: "human",
    txHash,
  });
  if (!ok) {
    throw new Error("Failed to update the DB after the vote (it may already be finalized)");
  }

  publish({
    escrowId,
    phase: "human",
    status: "done",
    label: approve ? "Human veto: APPROVE" : "Human veto: REJECT",
    detail: finalReason,
    data: { humanVote: approve, txHash, aiRecommendation: row.eligible === 1 },
  });
  publish({
    escrowId,
    phase: "final",
    status: "done",
    label: approve ? "RELEASED (human)" : "RETURNED (human)",
    detail: finalReason,
    data: {
      eligible: approve,
      decidedBy: "human",
      humanVote: approve,
      txHash,
    },
  });
  publish({
    escrowId,
    phase: "escrow",
    status: "done",
    label: "Confirmed on-chain (human vote)",
    detail: txHash,
    data: { txHash },
  });

  return { txHash };
}

// ── Event listener: react to EscrowCreated within milliseconds ───────────────
function startEventListener(): () => void {
  console.log(`⚡ [Event]  Listening for EscrowCreated events on contract ${contractAddress}...`);

  const FAST_FAIL_LIMIT = 5;
  const FAST_FAIL_WINDOW_MS = 60_000;
  const BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 16_000];
  const MAX_BACKOFF_MS = 30_000;
  const DEGRADE_AFTER_FAILURES = 10;
  const HEALTHY_RESET_MS = 30_000;
  const basePollingInterval = publicClient.pollingInterval;

  let stopped = false;
  let generation = 0;
  let currentUnwatch: (() => void) | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let healthyTimer: ReturnType<typeof setTimeout> | undefined;
  let failureTimestamps: number[] = [];
  let consecutiveFailures = 0;
  let backoffStep = 0;
  let reconnectCount = 0;
  let pollingOnlyMode = false;

  function teardownCurrentListener(): void {
    const unwatch = currentUnwatch;
    currentUnwatch = undefined;
    if (!unwatch) return;
    try {
      unwatch();
    } catch (err) {
      console.error(`[Event]  unwatch error:`, err instanceof Error ? err.message : err);
    }
  }

  function scheduleReconnect(delayMs: number): void {
    if (stopped || reconnectTimer !== undefined) return;
    reconnectCount = reconnectCount + 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      attach();
    }, delayMs);
  }

  function handleListenerError(err: unknown, gen: number): void {
    if (stopped || gen !== generation) return;
    try {
      generation = generation + 1;
      if (healthyTimer) {
        clearTimeout(healthyTimer);
        healthyTimer = undefined;
      }
      teardownCurrentListener();

      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Event]  watchContractEvent error:`, message);

      const now = Date.now();
      failureTimestamps = failureTimestamps.filter((t) => now - t <= FAST_FAIL_WINDOW_MS);
      failureTimestamps.push(now);
      consecutiveFailures = consecutiveFailures + 1;

      const lower = message.toLowerCase();
      const filterExpired =
        lower.includes("filter not found") ||
        lower.includes("missing or invalid parameters") ||
        lower.includes("invalid input");
      const transient =
        filterExpired ||
        lower.includes("network") ||
        lower.includes("timeout") ||
        lower.includes("timed out") ||
        lower.includes("connection") ||
        lower.includes("econn") ||
        lower.includes("fetch failed") ||
        lower.includes("socket hang up") ||
        lower.includes("request failed") ||
        lower.includes("http");

      let delayMs = 0;
      if (failureTimestamps.length >= FAST_FAIL_LIMIT || backoffStep > 0) {
        delayMs = BACKOFF_STEPS_MS[backoffStep] ?? MAX_BACKOFF_MS;
        backoffStep = backoffStep + 1;
        console.warn(
          `⚠️ [Event]  Repeated listener failures (${consecutiveFailures} consecutive, ` +
            `${failureTimestamps.length} in last ${FAST_FAIL_WINDOW_MS / 1000}s) — RPC may be down. ` +
            `Reconnect backing off: next attempt in ${delayMs}ms...`
        );
      } else if (filterExpired) {
        console.log(`⚡ [Event]  Filter expired (auto-recover) — reconnecting listener now...`);
      } else if (transient) {
        console.log(`⚡ [Event]  Transient network error (auto-recover) — reconnecting listener now...`);
      } else {
        console.warn(`⚠️ [Event]  Unexpected listener error — reconnecting listener now...`);
      }

      if (consecutiveFailures >= DEGRADE_AFTER_FAILURES && !pollingOnlyMode) {
        pollingOnlyMode = true;
        console.warn(
          `🚨 [Event]  ${consecutiveFailures} consecutive listener failures — entering POLLING-ONLY MODE. ` +
            `fallbackPoll() is now the primary mechanism; event listener keeps retrying in background ` +
            `(max ${MAX_BACKOFF_MS / 1000}s interval).`
        );
      }

      scheduleReconnect(delayMs);
    } catch (internalErr) {
      console.error(
        `[Event]  internal reconnect handler error:`,
        internalErr instanceof Error ? internalErr.message : internalErr
      );
      scheduleReconnect(0);
    }
  }

  function attach(): void {
    if (stopped) return;
    generation = generation + 1;
    const gen = generation;
    try {
      currentUnwatch = publicClient.watchContractEvent({
        address: contractAddress,
        abi: AEGIS_VAULT_ABI,
        eventName: "EscrowCreated",
        pollingInterval: basePollingInterval + reconnectCount,
        onLogs: (logs) => {
          if (stopped || gen !== generation) return;
          for (const log of logs) {
            const args = (log as unknown as { args: { escrowId?: `0x${string}`; sender?: string; recipient?: string; amount?: bigint } }).args;
            const escrowId = args?.escrowId;
            if (!escrowId) {
              console.warn(`[Event]  Received an EscrowCreated log with a missing escrowId — skipping.`);
              continue;
            }
            const sender = args?.sender ?? "unknown";
            const recipient = args?.recipient ?? "unknown";
            const amount = args?.amount ?? 0n;
            console.log(
              `\n⚡ [Event]  EscrowCreated detected!` +
              `\n   escrowId  : ${escrowId.slice(0, 18)}...` +
              `\n   sender    : ${sender}` +
              `\n   recipient : ${recipient}` +
              `\n   amount    : ${formatEther(amount)} BNB`
            );
            void processEscrow(escrowId, "event");
          }
        },
        onError: (err) => {
          handleListenerError(err, gen);
        },
      });
    } catch (err) {
      handleListenerError(err, gen);
      return;
    }

    if (reconnectCount > 0) {
      console.log(`⚡ [Event]  Event listener reconnected (try ${reconnectCount}).`);
    }

    healthyTimer = setTimeout(() => {
      healthyTimer = undefined;
      if (stopped || gen !== generation) return;
      const hadFailures =
        consecutiveFailures > 0 ||
        failureTimestamps.length > 0 ||
        backoffStep > 0 ||
        pollingOnlyMode;
      if (!hadFailures) return;
      const wasPollingOnly = pollingOnlyMode;
      consecutiveFailures = 0;
      failureTimestamps = [];
      backoffStep = 0;
      pollingOnlyMode = false;
      if (wasPollingOnly) {
        console.log(
          `✅ [Event]  Event listener stable again — exited POLLING-ONLY MODE; event-driven processing resumed.`
        );
      } else {
        console.log(
          `⚡ [Event]  Event listener stable for ${HEALTHY_RESET_MS / 1000}s — failure counters reset.`
        );
      }
    }, HEALTHY_RESET_MS);
  }

  attach();

  return () => {
    if (stopped) return;
    stopped = true;
    generation = generation + 1;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (healthyTimer) {
      clearTimeout(healthyTimer);
      healthyTimer = undefined;
    }
    teardownCurrentListener();
  };
}

// ── Fallback poller: safety net for missed events (RPC issues, restarts) ──────
// Runs at a much slower cadence than the old polling-only approach.
async function fallbackPoll() {
  try {
    const pendingIds = await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "getPendingEscrows",
    }) as readonly `0x${string}`[];

    const missed = pendingIds.filter((id: `0x${string}`) => !processingOrDone.has(id));

    if (missed.length > 0) {
      console.log(
        `[Fallback] Found ${missed.length} escrow(s) not yet processed — ` +
        `possibly missed by event listener. Processing now.`
      );
      for (const id of missed) {
        await processEscrow(id, "poll");
      }
    }
  } catch (err) {
    console.error(`[Fallback] Error during fallback poll:`, err);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
export function startEventDrivenOracle() {
  console.log(`🔮 AEGIS AI Oracle Service started (Event-Driven Mode).`);
  console.log(`   Oracle address  : ${account.address}`);
  console.log(`   Contract        : ${contractAddress}`);
  console.log(`   LLM model       : ${config.OLLAMA_MODEL}`);
  console.log(`   Confidence min  : ${config.LLM_CONFIDENCE_THRESHOLD}`);
  console.log(
    `   Human review    : ${config.HUMAN_ESCALATION_ENABLED ? `ON (conf ${config.HUMAN_CONF_MIN}–${config.LLM_CONFIDENCE_THRESHOLD})` : "OFF"}`
  );
  console.log(`   Fallback poll   : every ${config.POLLING_INTERVAL_MS}ms (safety net)\n`);

  // 0. Warmup: load the LLM model into VRAM before the first escrow (avoids cold-load timeouts)
  void warmupOllama();

  // 1. Start real-time event listener (primary mechanism)
  startEventListener();

  // 2. Do an immediate sweep to catch any escrows that existed before startup
  console.log(`[Startup]  Checking for pre-existing pending escrows...`);
  void fallbackPoll();

  // 3. Schedule periodic fallback poll as safety net
  //    (catches escrows if WebSocket/RPC drops events)
  setInterval(fallbackPoll, config.POLLING_INTERVAL_MS);
}

/** @deprecated Use startEventDrivenOracle() instead */
export const startPolling = startEventDrivenOracle;
