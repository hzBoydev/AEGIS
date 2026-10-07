// ── Local denylist: the rule that must survive an outage ──────────────────────
// WHY THIS SUITE EXISTS
// ──────────────────────
// Every other blocklist in this system is one HTTP call from being down. Rule 12 reads
// a local file, so an address on a published list is still blocked when GoPlus, the RPC
// and the database are all unreachable — that independence is the entire reason the
// file exists.
//
// The dangerous half is the failure mode: a missing or malformed list must read as
// UNKNOWN, never as "the list is empty, therefore clean". That is what most of these
// tests pin down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDenylist,
  checkLocalDenylist,
  denylistStats,
  type DenylistIndex,
} from "./denylist.js";

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aegis-denylist-"));
  const path = join(dir, "denylist.json");
  writeFileSync(path, contents);
  return path;
}

const A = "0x8589427373D6D84E98730D7795D8f6f8731FDA16";
const B = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";

test("loadDenylist: reads a well-formed file into a lowercase index", () => {
  const path = tempFile(
    JSON.stringify({
      version: "test",
      entries: [
        { address: A, list: "ofac", label: "listed mixer" },
        { address: B, list: "drainer", label: "drainer" },
      ],
    })
  );
  const idx = loadDenylist(path);
  assert.ok(idx);
  assert.equal(idx!.size, 2);
  assert.equal(idx!.get(A.toLowerCase())?.list, "ofac");
  assert.equal(idx!.get(A.toLowerCase())?.label, "listed mixer");
  rmSync(path, { force: true });
});

test("loadDenylist: keys are case-insensitive, because EVM addresses are", () => {
  const path = tempFile(JSON.stringify({ entries: [{ address: A, list: "ofac", label: "x" }] }));
  const idx = loadDenylist(path)!;
  assert.equal(checkLocalDenylist(A, idx)?.list, "ofac");
  assert.equal(checkLocalDenylist(A.toLowerCase(), idx)?.list, "ofac");
  assert.equal(checkLocalDenylist(`0x${A.slice(2).toUpperCase()}`, idx)?.list, "ofac");
  rmSync(path, { force: true });
});

test("checkLocalDenylist: a listed address hits, an unlisted address misses", () => {
  const path = tempFile(JSON.stringify({ entries: [{ address: A, list: "ofac", label: "x" }] }));
  const idx = loadDenylist(path)!;
  assert.notEqual(checkLocalDenylist(A, idx), null);
  assert.equal(checkLocalDenylist("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", idx), null);
  rmSync(path, { force: true });
});

test("loadDenylist: a MISSING file is unknown, not an empty list", () => {
  const idx = loadDenylist("/nonexistent/aegis/denylist.json");
  assert.equal(idx, null);
  // And the consequence for the caller: no hit AND no false all-clear.
  assert.equal(checkLocalDenylist(A, idx), null);
});

test("loadDenylist: invalid JSON is unknown, not an empty list", () => {
  const path = tempFile("{ this is not json");
  assert.equal(loadDenylist(path), null);
  rmSync(path, { force: true });
});

test("loadDenylist: a file with no entries array is unknown", () => {
  const path = tempFile(JSON.stringify({ version: "1.0" }));
  assert.equal(loadDenylist(path), null);
  rmSync(path, { force: true });
});

test("loadDenylist: an empty entries array is unknown (a 0-entry list proves nothing)", () => {
  const path = tempFile(JSON.stringify({ entries: [] }));
  assert.equal(loadDenylist(path), null);
  rmSync(path, { force: true });
});

test("loadDenylist: a malformed address is skipped, the valid ones still load", () => {
  const path = tempFile(
    JSON.stringify({
      entries: [
        { address: "0xnot-an-address", list: "ofac", label: "bad" },
        { address: A, list: "ofac", label: "good" },
        "not an object",
        { list: "ofac", label: "no address" },
      ],
    })
  );
  const idx = loadDenylist(path);
  assert.ok(idx, "one usable entry is enough to load");
  assert.equal(idx!.size, 1);
  assert.equal(checkLocalDenylist(A, idx!)?.label, "good");
  assert.equal(checkLocalDenylist("0xnot-an-address", idx!), null);
  rmSync(path, { force: true });
});

test("loadDenylist: missing list/label fall back rather than dropping the entry", () => {
  const path = tempFile(JSON.stringify({ entries: [{ address: A }] }));
  const idx = loadDenylist(path)!;
  const hit = checkLocalDenylist(A, idx);
  assert.notEqual(hit, null);
  assert.equal(hit!.list, "custom");
  assert.ok(hit!.label.length > 0);
  rmSync(path, { force: true });
});

test("checkLocalDenylist: a null index is unknown, never a hit and never clean", () => {
  assert.equal(checkLocalDenylist(A, null), null);
});

test("checkLocalDenylist: a miss on a loaded list is a miss, not a throw", () => {
  const idx: DenylistIndex = new Map();
  assert.equal(checkLocalDenylist(A, idx), null);
});

test("denylistStats: reports loaded state and entry count", () => {
  const stats = denylistStats();
  assert.equal(typeof stats.loaded, "boolean");
  assert.equal(typeof stats.entries, "number");
  assert.equal(typeof stats.path, "string");
  if (stats.loaded) assert.ok(stats.entries > 0, "loaded=true with 0 entries is a bug");
});

test("the shipped denylist file loads and is non-empty", () => {
  // Guards against the file being deleted, emptied, or corrupted by a bad edit — all
  // of which would silently turn rule 12 into a no-op.
  const idx = loadDenylist();
  assert.ok(idx, "the repository denylist must load");
  assert.ok(idx!.size > 0);
  for (const [addr, hit] of idx!) {
    assert.match(addr, /^0x[0-9a-f]{40}$/, `non-address key: ${addr}`);
    assert.ok(hit.list.length > 0);
    assert.ok(hit.label.length > 0, `${addr} has no provenance label`);
  }
});
