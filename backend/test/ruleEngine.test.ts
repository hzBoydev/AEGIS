import { describe, expect, it } from "vitest";
import { runRules } from "../src/ruleEngine.js";
import type { SecurityCheckResult } from "../src/goplusChecker.js";
import type { OnChainIntel } from "../src/bscscanChecker.js";

const clean = (over: Partial<SecurityCheckResult> = {}): SecurityCheckResult => ({
  status: "clean",
  riskFlags: [],
  source: "goplus",
  ...over,
});

const intel = (over: Partial<OnChainIntel> = {}): OnChainIntel => ({
  txCount: 100,
  walletAgeInDays: 400,
  isNewWallet: false,
  isContract: false,
  balanceBNB: 10,
  unavailable: false,
  ...over,
});

describe("ruleEngine — invariant", () => {
  it("TIDAK PERNAH menghasilkan APPROVE", () => {
    const securities: SecurityCheckResult[] = [
      clean(),
      clean({ status: "unavailable", source: "unavailable" }),
      clean({ status: "malicious", riskFlags: ["phishing_activities"] }),
      clean({
        status: "clean",
        rawData: { phishing_activities: "1" },
      }),
    ];
    const intels: OnChainIntel[] = [
      intel(),
      intel({ isContract: true }),
      intel({ balanceBNB: 0 }),
      intel({ isNewWallet: true, txCount: 0, walletAgeInDays: 0.1 }),
      intel({ walletAgeInDays: 10, txCount: 5, balanceBNB: 5 }),
      intel({ unavailable: true, balanceBNB: null, walletAgeInDays: null, txCount: null }),
    ];
    const amounts = [0, 0.001, 0.05, 0.5, 2, 100];

    for (const s of securities) {
      for (const i of intels) {
        for (const amount of amounts) {
          const result = runRules(s, i, amount);
          expect(["REJECT", "NEEDS_LLM"]).toContain(result.decision);
          expect(result.triggeredRule.length).toBeGreaterThan(0);
          expect(result.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("ruleEngine — hard REJECT rules", () => {
  it("Rule 1: GoPlus malicious + flags → REJECT", () => {
    const r = runRules(
      clean({ status: "malicious", riskFlags: ["blacklist_doubt"] }),
      intel(),
      0.5
    );
    expect(r.decision).toBe("REJECT");
    expect(r.triggeredRule).toBe("RULE_1_GOPLUS_MALICIOUS");
  });

  it("Rule 1b: GoPlus malicious tanpa flag → tetap REJECT", () => {
    const r = runRules(clean({ status: "malicious" }), intel(), 0.5);
    expect(r.decision).toBe("REJECT");
    expect(r.triggeredRule).toBe("RULE_1B_GOPLUS_MALICIOUS_NO_FLAGS");
  });

  it("Rule 8: flag phishing eksplisit di rawData → REJECT", () => {
    const r = runRules(
      clean({ rawData: { phishing_activities: "1" } }),
      intel(),
      0.5
    );
    expect(r.decision).toBe("REJECT");
    expect(r.triggeredRule).toBe("RULE_8_GOPLUS_PHISHING_FLAGS");
  });

  it("Rule 6: penerima smart contract → REJECT", () => {
    const r = runRules(clean(), intel({ isContract: true }), 0.5);
    expect(r.decision).toBe("REJECT");
    expect(r.triggeredRule).toBe("RULE_6_CONTRACT_RECEIVER");
  });

  it("Rule 7: saldo 0 + amount signifikan → REJECT", () => {
    const r = runRules(clean(), intel({ balanceBNB: 0 }), 0.05);
    expect(r.decision).toBe("REJECT");
    expect(r.triggeredRule).toBe("RULE_7_ZERO_BALANCE_SIGNIFICANT_AMOUNT");
  });

  it("Rule 2: wallet baru + low-activity + amount signifikan → REJECT", () => {
    const r = runRules(
      clean(),
      intel({ isNewWallet: true, walletAgeInDays: 0.5, txCount: 1, balanceBNB: 5 }),
      0.05
    );
    expect(r.decision).toBe("REJECT");
    expect(r.triggeredRule).toBe("RULE_2_NEW_WALLET_SIGNIFICANT_AMOUNT");
  });
});

describe("ruleEngine — NEEDS_LLM rules", () => {
  it("Rule 3: wallet baru + amount kecil → LLM", () => {
    const r = runRules(
      clean(),
      intel({ isNewWallet: true, walletAgeInDays: 0.5, txCount: 1, balanceBNB: 5 }),
      0.001
    );
    expect(r.decision).toBe("NEEDS_LLM");
    expect(r.triggeredRule).toBe("RULE_3_NEW_WALLET_SMALL_AMOUNT");
  });

  it("Rule 4: GoPlus unavailable → LLM (bukan dianggap aman)", () => {
    const r = runRules(
      clean({ status: "unavailable", source: "unavailable" }),
      intel(),
      0.5
    );
    expect(r.decision).toBe("NEEDS_LLM");
    expect(r.triggeredRule).toBe("RULE_4_GOPLUS_UNAVAILABLE");
  });

  it("Rule 5: BscScan unavailable → LLM", () => {
    const r = runRules(
      clean(),
      intel({ unavailable: true, balanceBNB: null, walletAgeInDays: null, txCount: null }),
      0.5
    );
    expect(r.decision).toBe("NEEDS_LLM");
    expect(r.triggeredRule).toBe("RULE_5_BSCSCAN_UNAVAILABLE");
  });

  it("Rule 9: transfer sangat besar → LLM", () => {
    const r = runRules(clean(), intel(), 2);
    expect(r.decision).toBe("NEEDS_LLM");
    expect(r.triggeredRule).toBe("RULE_9_VERY_LARGE_TRANSFER");
  });

  it("Rule 10: wallet menengah + low-activity + signifikan → LLM", () => {
    const r = runRules(
      clean(),
      intel({ walletAgeInDays: 10, txCount: 5, balanceBNB: 5 }),
      0.5
    );
    expect(r.decision).toBe("NEEDS_LLM");
    expect(r.triggeredRule).toBe("RULE_10_MEDIUM_WALLET_LOW_ACTIVITY");
  });

  it("Default: kasus bersih → LLM", () => {
    const r = runRules(clean(), intel(), 0.5);
    expect(r.decision).toBe("NEEDS_LLM");
    expect(r.triggeredRule).toBe("RULE_DEFAULT");
  });
});
