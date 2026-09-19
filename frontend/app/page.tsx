"use client";

import { useState, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseEther } from "viem";
import { CONTRACT_ADDRESS, AEGIS_VAULT_ABI } from "@/config/contract";

interface Decision {
  id: number;
  escrow_id: string;
  sender: string;
  recipient: string;
  amount: string;
  eligible: number;
  confidence: number;
  reasoning: string;
  tx_hash: string | null;
  created_at: string;
}

function useEscrowHistory() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("http://localhost:3001/api/escrows");
        const json = await res.json();
        if (json.success) setDecisions(json.data);
      } catch (err) {
        console.error("Gagal fetch riwayat:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  return { decisions, loading };
}

function truncateAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function EscrowHistory() {
  const { decisions, loading } = useEscrowHistory();

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)] mt-10">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--bronze)] pulse" />
        Memuat riwayat
      </div>
    );
  }

  if (decisions.length === 0) {
    return (
      <div className="mt-12 py-10 text-center border-t" style={{ borderColor: "var(--border)" }}>
        <p className="text-sm text-[var(--text-secondary)]">
          Belum ada transaksi yang diperiksa. Kirim token untuk melihat Aegis bekerja.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-14">
      <p className="font-display text-lg mb-6" style={{ color: "var(--text-primary)" }}>
        Riwayat Penjagaan
      </p>

      <div className="relative pl-6 border-l flex flex-col gap-7" style={{ borderColor: "var(--border)" }}>
        {decisions.map((d) => (
          <div key={d.id} className="relative">
            <span
              className="absolute -left-[27px] top-1.5 w-3 h-3 rounded-full border-2"
              style={{
                borderColor: d.eligible ? "var(--safe)" : "var(--danger)",
                background: "var(--bg)",
              }}
            />
            <div className="flex items-baseline justify-between gap-4">
              <p className="font-display text-lg">
                {d.amount} BNB{" "}
                <span
                  className="text-sm font-sans"
                  style={{ color: d.eligible ? "var(--safe)" : "var(--danger)" }}
                >
                  {d.eligible ? "diteruskan" : "dikembalikan"}
                </span>
              </p>
              <span className="text-xs text-[var(--text-secondary)] whitespace-nowrap">
                {d.confidence}% yakin
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              ke {truncateAddress(d.recipient)}
            </p>
            <p className="text-sm mt-2 leading-relaxed" style={{ color: "var(--text-primary)" }}>
              {d.reasoning}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const { isConnected } = useAccount();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recipient || !amount) return;
    writeContract({
      address: CONTRACT_ADDRESS,
      abi: AEGIS_VAULT_ABI,
      functionName: "submitTransfer",
      args: [recipient as `0x${string}`],
      value: parseEther(amount),
    });
  }

  return (
    <div className="flex flex-col flex-1 min-h-screen" style={{ background: "var(--bg)" }}>
      <header className="w-full border-b" style={{ borderColor: "var(--border)" }}>
        <div className="max-w-xl mx-auto flex justify-between items-center py-6 px-4">
          <div className="flex items-center gap-3">
            <svg width="22" height="26" viewBox="0 0 22 26" fill="none">
              <path
                d="M11 1L20 5V12C20 18 16 23 11 25C6 23 2 18 2 12V5L11 1Z"
                stroke="var(--bronze)"
                strokeWidth="1.5"
              />
              <path d="M11 6V20M6 10H16" stroke="var(--bronze)" strokeWidth="1" />
            </svg>
            <h1 className="font-display text-xl tracking-wide" style={{ color: "var(--text-primary)" }}>
              AEGIS
            </h1>
          </div>
          <ConnectButton />
        </div>
      </header>

      <main className="w-full max-w-xl mx-auto px-4 py-14 flex-1">
        {!isConnected ? (
          <div className="text-center py-20">
            <p className="font-display text-3xl mb-4" style={{ color: "var(--text-primary)" }}>
              Perisai bagi transaksimu
            </p>
            <p className="text-[var(--text-secondary)] text-sm max-w-sm mx-auto leading-relaxed">
              Setiap transfer dijaga oleh AI Oracle sebelum dana sampai ke penerima.
              Sambungkan wallet untuk memulai.
            </p>
          </div>
        ) : (
          <div>
            <p className="font-display text-3xl mb-2" style={{ color: "var(--text-primary)" }}>
              Kirim Token
            </p>
            <p className="text-sm text-[var(--text-secondary)] mb-9">
              BNB Testnet — ditahan hingga diverifikasi aman
            </p>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-2">
                  Alamat penerima
                </label>
                <input
                  type="text"
                  placeholder="0x..."
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  className="w-full rounded-md px-4 py-3 text-sm outline-none border transition-colors"
                  style={{ background: "var(--surface)", borderColor: "var(--border)" }}
                  required
                />
              </div>

              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-2">
                  Jumlah (BNB)
                </label>
                <input
                  type="text"
                  placeholder="0.001"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full rounded-md px-4 py-3 text-sm outline-none border transition-colors"
                  style={{ background: "var(--surface)", borderColor: "var(--border)" }}
                  required
                />
              </div>

              <button
                type="submit"
                disabled={isPending || isConfirming}
                className="rounded-md px-4 py-3 text-sm font-medium transition-opacity disabled:opacity-40 mt-2"
                style={{ background: "var(--bronze)", color: "var(--surface)" }}
              >
                {isPending
                  ? "Menunggu konfirmasi wallet"
                  : isConfirming
                  ? "Memproses transaksi"
                  : "Kirim ke Escrow"}
              </button>
            </form>

            {error && (
              <p className="mt-4 text-sm" style={{ color: "var(--danger)" }}>
                {error.message.split("\n")[0]}
              </p>
            )}

            {isConfirmed && (
              <div
                className="mt-5 p-4 rounded-md border"
                style={{ borderColor: "var(--safe)", background: "var(--surface)" }}
              >
                <p className="text-sm" style={{ color: "var(--safe)" }}>
                  Diterima. AI Oracle sedang memeriksa transaksi ini.
                </p>
              </div>
            )}

            <EscrowHistory />
          </div>
        )}
      </main>
    </div>
  );
}
