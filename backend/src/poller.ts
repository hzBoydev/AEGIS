import { formatEther } from "viem";
import { bscTestnet } from "viem/chains";
import { publicClient, walletClient, config, account } from "./config.js";
import { AEGIS_VAULT_ABI } from "./abi.js";
import { runSecurityPipeline } from "./securityPipeline.js";
import { saveDecision } from "./db.js";

const contractAddress = config.CONTRACT_ADDRESS;

// Track escrows being processed or already done in this session.
// Prevents double-processing across polling intervals.
const processingOrDone = new Set<string>();

async function checkAndProcessEscrows() {
  try {
    const pendingIds = await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "getPendingEscrows",
    });

    const newOnes = pendingIds.filter((id) => !processingOrDone.has(id));

    if (newOnes.length === 0) {
      console.log(`[${new Date().toLocaleTimeString()}] No new escrows.`);
      return;
    }

    console.log(
      `[${new Date().toLocaleTimeString()}] Found ${newOnes.length} new escrow(s).`
    );

    for (const escrowId of newOnes) {
      // Mark BEFORE processing so concurrent intervals don't re-pick it
      processingOrDone.add(escrowId);
      await processEscrow(escrowId);
    }
  } catch (err) {
    console.error("[Poller] Error during polling:", err);
  }
}

async function processEscrow(escrowId: `0x${string}`) {
  console.log(`\n>> Processing escrow: ${escrowId}`);

  try {
    // ── Fetch escrow data from contract ──────────────────────────────────────
    const [sender, recipient, amount] = await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "getEscrowData",
      args: [escrowId],
    });

    const amountBNB = Number(formatEther(amount));

    console.log(`   Sender    : ${sender}`);
    console.log(`   Recipient : ${recipient}`);
    console.log(`   Amount    : ${amountBNB} BNB`);

    // ── Run security pipeline ─────────────────────────────────────────────────
    const decision = await runSecurityPipeline(recipient, amountBNB);

    console.log(`\n[Final]   eligible=${decision.eligible} risk=${decision.riskLevel} decidedBy=${decision.decidedBy}`);

    // ── Send decision to smart contract ───────────────────────────────────────
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

    // Wait for on-chain confirmation before proceeding
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
    // Keep in processingOrDone to prevent retry loop
  }
}

export function startPolling() {
  console.log(`🔮 AEGIS AI Oracle Service started.`);
  console.log(`   Oracle address : ${account.address}`);
  console.log(`   Contract       : ${contractAddress}`);
  console.log(`   Poll interval  : ${config.POLLING_INTERVAL_MS}ms`);
  console.log(`   LLM model      : ${config.OLLAMA_MODEL}`);
  console.log(`   Confidence min : ${config.LLM_CONFIDENCE_THRESHOLD}\n`);

  checkAndProcessEscrows();
  setInterval(checkAndProcessEscrows, config.POLLING_INTERVAL_MS);
}
