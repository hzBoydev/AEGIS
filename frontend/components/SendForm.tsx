"use client";

import { useEffect, useRef, useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseEther } from "viem";
import { CONTRACT_ADDRESS, AEGIS_VAULT_ABI } from "@/config/contract";

interface SendFormProps {
  onSubmitted?: () => void;
}

const PRESET_AMOUNTS = ["0.001", "0.01", "0.05", "0.1"];

export default function SendForm({ onSubmitted }: SendFormProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash });

  const notifiedHash = useRef<string | null>(null);

  useEffect(() => {
    if (hash && hash !== notifiedHash.current) {
      notifiedHash.current = hash;
      onSubmitted?.();
    }
  }, [hash, onSubmitted]);

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
    <section className="card overflow-hidden">
      <div className="card-head">
        <div>
          <p className="eyebrow">Step 01</p>
          <p className="font-display mt-1 text-xl font-bold text-ink">Send Token Securely</p>
          <p className="text-muted mt-1 text-xs">
            Funds land in the holding vault (Escrow) before verification
          </p>
        </div>
        <span className="badge badge-bronze">Escrow Vault</span>
      </div>

      <form onSubmit={handleSubmit} className="card-pad flex flex-col gap-5">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="recipient" className="field-label mb-0">
              Recipient Wallet Address
            </label>
            <span className="text-muted text-[11px] font-mono">Format: 0x... (BSC Testnet)</span>
          </div>
          <input
            id="recipient"
            type="text"
            placeholder="0x7BF05D8E9842cd38729f781365745B6635788Ee4"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="field font-mono text-xs sm:text-sm"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="amount" className="field-label mb-0">
              Transfer Amount (BNB)
            </label>
            <div className="flex items-center gap-1.5">
              {PRESET_AMOUNTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p)}
                  className={`rounded-full px-2.5 py-1 text-xs font-mono font-medium transition-all ${
                    amount === p
                      ? "bg-black text-white shadow-sm"
                      : "border border-black/10 bg-white text-black/70 hover:border-black/30 hover:bg-black/5"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <input
            id="amount"
            type="text"
            inputMode="decimal"
            placeholder="Example: 0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="field font-mono"
            required
          />
        </div>

        <div className="flex flex-col gap-3 pt-2">
          <button
            type="submit"
            disabled={isPending || isConfirming}
            className="group relative flex w-full items-center justify-center gap-2 rounded-xl bg-[#111111] py-3.5 px-6 text-sm font-bold text-white shadow-xl shadow-black/20 transition-all duration-300 hover:bg-black hover:scale-[1.01] hover:shadow-2xl hover:shadow-black/30 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {isPending ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Waiting for Wallet Confirmation...
              </span>
            ) : isConfirming ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Processing on BSC Testnet...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <span>Send with Aegis Protection</span>
                <span className="transition-transform duration-300 group-hover:translate-x-1">→</span>
              </span>
            )}
          </button>

          <div className="flex items-center justify-between text-muted text-[11px] px-1">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
              Funds stay safe in escrow until verified
            </span>
            <span className="font-mono">Network: BSC Testnet</span>
          </div>
        </div>

        {error && (
          <div className="alert alert-danger" role="alert">
            <span aria-hidden className="text-base font-bold">✕</span>
            <div>
              <p className="font-semibold text-xs">{error.message.split("\n")[0]}</p>
              <p className="mt-1 text-[11px] opacity-80">
                Make sure your BNB balance is sufficient and your wallet network is set to BSC Testnet.
              </p>
            </div>
          </div>
        )}

        {isConfirming && (
          <div className="alert alert-safe" role="status">
            <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-600 animate-ping shrink-0 mt-1" />
            <div>
              <p className="font-semibold text-xs">Waiting for block confirmation on BSC Testnet...</p>
              <p className="text-[11px] opacity-85">Your transaction is being recorded in the escrow contract.</p>
            </div>
          </div>
        )}

        {isConfirmed && (
          <div className="alert alert-safe" role="status">
            <span aria-hidden className="text-base font-bold text-emerald-700">✓</span>
            <div>
              <p className="font-bold text-sm">Transaction Created Successfully!</p>
              <p className="mt-1 text-xs opacity-90 leading-relaxed">
                The funds are now secured in the escrow vault. The automatic verification system is running.
                You can follow the result and progress in the <strong>Live Verification Monitor</strong> section below.
              </p>
              {hash && (
                <p className="mt-2 font-mono text-[11px] opacity-75">
                  Transaction ID: {hash.slice(0, 24)}...
                </p>
              )}
            </div>
          </div>
        )}
      </form>
    </section>
  );
}