import { formatEther } from "viem";
import { bscTestnet } from "viem/chains";
import { publicClient, walletClient, config, account } from "./config.js";
import { AEGIS_VAULT_ABI } from "./abi.js";
import { runSecurityPipeline } from "./securityPipeline.js";
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
    const decision = await runSecurityPipeline(recipient, amountBNB);

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

  const unwatch = publicClient.watchContractEvent({
    address: contractAddress,
    abi: AEGIS_VAULT_ABI,
    eventName: "EscrowCreated",
    onLogs: (logs) => {
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
      console.error(`[Event]  watchContractEvent error:`, err.message);
      // Non-fatal: fallback poller will catch any missed escrows
    },
  });

  return unwatch;
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
