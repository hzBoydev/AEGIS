"use client";

import { isValidAddress, truncateAddress } from "@/lib/utils";

interface AddressFilterProps {
  value: string;
  onChange: (value: string) => void;
  walletAddress?: string;
  id: string;
}

export default function AddressFilter({
  value,
  onChange,
  walletAddress,
  id,
}: AddressFilterProps) {
  const trimmed = value.trim();
  const hasQuery = trimmed.length > 0;
  const invalid = hasQuery && !isValidAddress(trimmed);
  const filtered = hasQuery && !invalid;
  const target = filtered ? trimmed : walletAddress;

  return (
    <div className="mb-3.5 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="field-label mb-0 shrink-0 font-medium text-xs">
          Address Filter:
        </label>
        <input
          id={id}
          type="text"
          className="field min-w-0 flex-1 py-2 px-3 text-xs font-mono"
          placeholder="Search any wallet address (0x...)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0"
          onClick={() => onChange("")}
          disabled={!filtered}
        >
          Connected Wallet
        </button>
      </div>

      <p className="text-muted text-[11px]" role="status">
        {invalid ? (
          <span className="text-danger font-semibold">
            Invalid address format — use a 0x address with 40 hex characters.
          </span>
        ) : filtered ? (
          <>
            Showing records for address <span className="font-mono font-semibold text-ink">{truncateAddress(trimmed)}</span> (you can look up any public address).
          </>
        ) : target ? (
          <>
            Showing data for the connected wallet: <span className="font-mono font-semibold text-ink">{truncateAddress(target)}</span>.
          </>
        ) : (
          <>Connect a wallet or type an address above to view transaction data.</>
        )}
      </p>
    </div>
  );
}
