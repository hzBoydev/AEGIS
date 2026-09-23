import { formatEther } from "viem";
import { bscTestnet } from "viem/chains";
import { publicClient, walletClient, config, account } from "./config.js";
import { AEGIS_VAULT_ABI } from "./abi.js";
import { runSecurityPipeline } from "./securityPipeline.js";
import { warmupOllama } from "./aiAnalyzer.js";
import { saveDecision } from "./db.js";

const contractAddress = config.CONTRACT_ADDRESS;

// ── De-duplication guard ──────────────────────────────────────────────────────
// Prevents double-processing if an event fires AND the fallback poller catches
// the same escrow within the same session.
const processingOrDone = new Set<string>();

// ── Core: process a single escrow by ID ──────────────────────────────────────
async function processEscrow(
  escrowId: `0x${string}`,
  trigger: "event" | "poll"
) {
  if (processingOrDone.has(escrowId)) {
    console.log(`[${trigger.toUpperCase()}] Skipping already-processed: ${escrowId.slice(0, 10)}...`);
    return;
  }
  processingOrDone.add(escrowId);

  console.log(`\n>> [${trigger.toUpperCase()}] Processing escrow: ${escrowId}`);

  try {
    // ── Fetch escrow data from contract ───────────────────────────────────────
    const escrowData = await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "getEscrowData",
      args: [escrowId],
    }) as readonly [string, string, bigint, number, bigint];
    const [sender, recipient, amount] = escrowData;

    const amountBNB = Number(formatEther(amount));

    console.log(`   Sender    : ${sender}`);
    console.log(`   Recipient : ${recipient}`);
    console.log(`   Amount    : ${amountBNB} BNB`);

    // ── Run AI security pipeline ───────────────────────────────────────────────
    const decision = await runSecurityPipeline(sender, recipient, amountBNB);

    console.log(
      `\n[Final]   eligible=${decision.eligible} risk=${decision.riskLevel} decidedBy=${decision.decidedBy}`
    );

    // ── Submit decision to smart contract ─────────────────────────────────────
    console.log(`\n   Submitting decision to smart contract...`);
    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "fulfillVerification",
      args: [escrowId, decision.eligible, decision.reason],
      chain: bscTestnet,
      account,
    });

    console.log(`   ✅ Transaction submitted: ${txHash}`);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`   ✅ Confirmed on-chain.`);

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
    });

    console.log(`   Saved to database.\n`);
  } catch (err) {
    console.error(
      `   ❌ Failed to process escrow ${escrowId}:`,
      err instanceof Error ? err.message : err
    );
    // Keep in processingOrDone to prevent infinite retry loop
  }
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
              console.warn(`[Event]  Received EscrowCreated log with missing escrowId — skipping.`);
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
  console.log(`   Fallback poll   : every ${config.POLLING_INTERVAL_MS}ms (safety net)\n`);

  // 0. Warmup: load model LLM ke VRAM sebelum escrow pertama (anti cold-load timeout)
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
