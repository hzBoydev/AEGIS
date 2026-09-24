export function truncateAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) → locale id-ID. */
export function formatTimestamp(value: string): string {
  if (!value) return "";
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
