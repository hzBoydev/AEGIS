import { formatEther } from "viem";
import { publicClient, walletClient, config, account } from "./config.js";
import { AEGIS_VAULT_ABI } from "./abi.js";
import { analyzeRisk } from "./aiAnalyzer.js";
import { saveDecision } from "./db.js";

const contractAddress = config.CONTRACT_ADDRESS;

// Penanda escrow yang sedang/sudah diproses di sesi ini, supaya tidak diproses dobel
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
      console.log(`[${new Date().toLocaleTimeString()}] Tidak ada escrow baru.`);
      return;
    }

    console.log(`[${new Date().toLocaleTimeString()}] Ditemukan ${newOnes.length} escrow baru.`);

    for (const escrowId of newOnes) {
      processingOrDone.add(escrowId); // tandai SEBELUM diproses, agar tidak diambil siklus berikutnya
      await processEscrow(escrowId);
    }
  } catch (err) {
    console.error("Error saat polling:", err);
  }
}

async function processEscrow(escrowId: `0x${string}`) {
  console.log(`\n>> Memproses escrow: ${escrowId}`);

  try {
    const [sender, recipient, amount] = await publicClient.readContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "getEscrowData",
      args: [escrowId],
    });

    const amountBNB = formatEther(amount);
    console.log(`   Sender: ${sender}`);
    console.log(`   Recipient: ${recipient}`);
    console.log(`   Amount: ${amountBNB} BNB`);

    const txCount = await publicClient.getTransactionCount({ address: recipient });
    const recipientAgeInfo =
      txCount === 0 ? "address ini belum pernah melakukan transaksi apapun" : "address ini pernah aktif bertransaksi";

    console.log(`   Menganalisis dengan AI...`);
    const result = await analyzeRisk({
      recipient,
      amountBNB,
      recipientTxCount: txCount,
      recipientAgeInfo,
    });

    console.log(`   Keputusan AI: eligible=${result.eligible}, confidence=${result.confidence}`);
    console.log(`   Alasan: ${result.reasoning}`);

    console.log(`   Mengirim keputusan ke smart contract...`);
    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: AEGIS_VAULT_ABI,
      functionName: "fulfillVerification",
      args: [escrowId, result.eligible, result.reasoning],
    });

    console.log(`   ✅ Transaksi terkirim: ${txHash}`);

    // Tunggu transaksi benar-benar terkonfirmasi sebelum lanjut ke escrow berikutnya
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    saveDecision({
      escrowId,
      sender,
      recipient,
      amount: amountBNB,
      eligible: result.eligible,
      confidence: result.confidence,
      reasoning: result.reasoning,
      txHash,
    });

    console.log(`   Tersimpan ke database.\n`);
  } catch (err) {
    console.error(`   ❌ Gagal memproses escrow ${escrowId}:`, err instanceof Error ? err.message : err);
    // Tetap tercatat di processingOrDone supaya tidak retry-loop terus menerus
  }
}

export function startPolling() {
  console.log(`🔮 AI Oracle Service dimulai.`);
  console.log(`   Oracle address: ${account.address}`);
  console.log(`   Contract address: ${contractAddress}`);
  console.log(`   Interval polling: ${config.POLLING_INTERVAL_MS}ms\n`);

  checkAndProcessEscrows();
  setInterval(checkAndProcessEscrows, config.POLLING_INTERVAL_MS);
}
