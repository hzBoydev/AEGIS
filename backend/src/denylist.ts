import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";

// ── Local denylist (GoPlus-independent) ───────────────────────────────────────
/**
 * A tiny, hand-maintained, GoPlus-independent blocklist.
 *
 * WHY IT EXISTS. Every third-party screen is one HTTP call away from being down.
 * When GoPlus is unavailable the pipeline degrades to NEEDS_LLM — correct, but it
 * means a sanctioned or drainer address has no deterministic block at all. A local
 * file has no such dependency: rule 12 reads it before any verdict exists, so an
 * outage cannot turn a known-bad address into a coin flip for the LLM.
 *
 * WHAT IT IS NOT. It is NOT a threat-intelligence feed:
 *   - it is NOT downloaded or refreshed automatically — a stale list is worse than a
 *     small honest one, so `DENYLIST.json` says in `notice` that it must be refreshed
 *     and names the sources;
 *   - it contains ONLY publicly published addresses. Nothing here is invented, and no
 *     address may be added without a source;
 *   - a MISSING or malformed file is NOT "the list is empty, therefore clean". Every
 *     lookup returns null (= unknown), and a warning is logged. A blocklist that fails
 *     open must say so loudly, or the silence reads as an all-clear.
 *
 * A hit is a positively observed fact (this exact address is on a published list),
 * which is what makes rule 12 a legitimate hard REJECT.
 */

export interface DenylistHit {
  /** Which list the address came from: "ofac" | "drainer" | "sweeper7702" | "custom". */
  list: string;
  /** Human-readable provenance for the UI and the rejection reason. */
  label: string;
}

/** Address → { list, label }, keys lowercased. */
export type DenylistIndex = Map<string, DenylistHit>;

interface DenylistFile {
  version?: unknown;
  entries?: unknown;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Read and validate the denylist file.
 *
 * Returns null (never throws) when the file is missing, unreadable, not JSON, or
 * carries no usable entry — all of which mean "unknown", never "clean".
 */
export function loadDenylist(path: string = config.DENYLIST_PATH): DenylistIndex | null {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch (err) {
    console.warn(
      `[Denylist] ⚠️  could not read the local denylist at ${path} ` +
        `(${err instanceof Error ? err.message : err}) — every lookup is UNKNOWN, not clean.`
    );
    return null;
  }

  let parsed: DenylistFile;
  try {
    parsed = JSON.parse(raw) as DenylistFile;
  } catch {
    console.warn(
      `[Denylist] ⚠️  ${path} is not valid JSON — every lookup is UNKNOWN, not clean.`
    );
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    console.warn(
      `[Denylist] ⚠️  ${path} has no "entries" array — every lookup is UNKNOWN, not clean.`
    );
    return null;
  }

  const index: DenylistIndex = new Map();
  let skipped = 0;
  for (const entry of parsed.entries) {
    if (entry === null || typeof entry !== "object") {
      skipped += 1;
      continue;
    }
    const { address, list, label } = entry as Record<string, unknown>;
    if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
      skipped += 1;
      continue;
    }
    index.set(address.toLowerCase(), {
      list: typeof list === "string" && list.trim() !== "" ? list : "custom",
      label: typeof label === "string" && label.trim() !== "" ? label : "listed address",
    });
  }

  if (index.size === 0) {
    console.warn(
      `[Denylist] ⚠️  ${path} produced 0 usable entries — every lookup is UNKNOWN, not clean.`
    );
    return null;
  }

  console.log(
    `[Denylist] loaded ${index.size} entr${index.size === 1 ? "y" : "ies"} ` +
      `from ${path}${skipped > 0 ? ` (${skipped} malformed entr${skipped === 1 ? "y" : "ies"} skipped)` : ""}` +
      `${typeof parsed.version === "string" ? ` [version ${parsed.version}]` : ""}.`
  );
  return index;
}

/**
 * Cached index, loaded once on first use (so importing this module never does I/O)
 * and then reused for the process lifetime.
 *
 * `null` here is a legitimate cached state: the file was already checked and there is
 * nothing to load, so a later call must NOT re-read and re-warn on every escrow.
 */
let cached: DenylistIndex | null | undefined;

/**
 * Exact-address lookup in the local denylist.
 *
 * @param address  EVM address. Case-insensitive (EVM addresses are not).
 * @param index    Index to use; omit to use the process-wide one. `null` means the
 *                 list is unavailable, which returns `null` — unknown, not clean.
 */
export function checkLocalDenylist(
  address: string,
  index?: DenylistIndex | null
): DenylistHit | null {
  let idx = index;
  if (idx === undefined) {
    if (cached === undefined) cached = loadDenylist();
    idx = cached;
  }
  if (idx === null) return null;
  return idx.get(address.toLowerCase()) ?? null;
}

/** Diagnostics for a startup log line. Never used for a verdict. */
export function denylistStats(): { loaded: boolean; entries: number; path: string } {
  if (cached === undefined) cached = loadDenylist();
  return {
    loaded: cached !== null,
    entries: cached?.size ?? 0,
    path: config.DENYLIST_PATH,
  };
}