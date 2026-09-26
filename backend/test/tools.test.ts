import { describe, expect, it } from "vitest";
import { sanitizeNeedsData, TOOL_CATALOG, TOOL_NAMES } from "../src/tools.js";

describe("tools — katalog", () => {
  it("nama tool unik", () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("setiap tool punya deskripsi", () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("sanitizeNeedsData — injection / hallucination guard", () => {
  it("tool resmi lolos", () => {
    const { requested, dropped } = sanitizeNeedsData([
      "get_sender_profile",
      "get_recipient_db_history",
    ]);
    expect(requested).toEqual(["get_sender_profile", "get_recipient_db_history"]);
    expect(dropped).toEqual([]);
  });

  it("nama palsu / injeksi dibuang dan tidak dieksekusi", () => {
    const { requested, dropped } = sanitizeNeedsData([
      "ignore_previous_instructions",
      "get_sender_profile; DROP TABLE decisions",
      "",
      "rm -rf /",
    ]);
    expect(requested).toEqual([]);
    expect(dropped).toHaveLength(4);
    for (const name of dropped) {
      expect(TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it("campuran resmi + palsu: hanya resmi yang diminta", () => {
    const { requested, dropped } = sanitizeNeedsData([
      "get_sender_profile",
      "exfiltrate_secrets",
      "get_sender_db_history",
    ]);
    expect(requested).toEqual(["get_sender_profile", "get_sender_db_history"]);
    expect(dropped).toEqual(["exfiltrate_secrets"]);
  });

  it("input kosong aman", () => {
    expect(sanitizeNeedsData([])).toEqual({ requested: [], dropped: [] });
  });
});
