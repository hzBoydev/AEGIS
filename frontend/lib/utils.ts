export function truncateAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Seconds → "8 seconds" / "1 minute 5 seconds". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (rest === 0) return `${m} minute${m === 1 ? "" : "s"}`;
  return `${m} minute${m === 1 ? "" : "s"} ${rest} second${rest === 1 ? "" : "s"}`;
}

/** Valid address? (0x + 40 hex) */
export function isValidAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/** SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) → en-US locale. */
export function formatTimestamp(value: string): string {
  if (!value) return "";
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
