import { describe, expect, it } from "vitest";
import { evaluateFinalOutcome } from "../src/securityPipeline.js";

const base = {
  judgeEligible: true,
  judgeConfidence: 0.9,
  investigatorEligible: true,
  securityStatus: "clean" as const,
  threshold: 0.8,
  humanMin: 0.55,
  humanEscalationEnabled: true,
};

describe("evaluateFinalOutcome — human escalation ON (default)", () => {
  it("confidence di bawah humanMin → fail-safe REJECT", () => {
    expect(evaluateFinalOutcome({ ...base, judgeConfidence: 0.4 })).toEqual({
      kind: "fail_low_confidence",
    });
  });

  it("fail-safe diprioritaskan di atas sinyal malicious", () => {
    expect(
      evaluateFinalOutcome({
        ...base,
        judgeConfidence: 0.1,
        securityStatus: "malicious",
      })
    ).toEqual({ kind: "fail_low_confidence" });
  });

  it("GoPlus malicious → hard override REJECT (tanpa vote manusia)", () => {
    expect(
      evaluateFinalOutcome({ ...base, securityStatus: "malicious" })
    ).toEqual({ kind: "override_malicious" });
  });

  it("zona abu-abu (humanMin ≤ conf < threshold) → butuh manusia", () => {
    const guard = evaluateFinalOutcome({ ...base, judgeConfidence: 0.7 });
    expect(guard.kind).toBe("needs_human");
  });

  it("sidang berbalik (Investigator ≠ Judge) → butuh manusia", () => {
    const guard = evaluateFinalOutcome({
      ...base,
      judgeConfidence: 0.95,
      investigatorEligible: false,
    });
    expect(guard.kind).toBe("needs_human");
  });

  it("confidence tinggi + selaras → ikut Judge", () => {
    expect(evaluateFinalOutcome(base)).toEqual({ kind: "judge", eligible: true });
    expect(
      evaluateFinalOutcome({ ...base, judgeEligible: false, investigatorEligible: false })
    ).toEqual({ kind: "judge", eligible: false });
  });

  it("Investigator undefined tidak memicu eskalasi berbalik", () => {
    expect(
      evaluateFinalOutcome({ ...base, investigatorEligible: undefined })
    ).toEqual({ kind: "judge", eligible: true });
  });
});

describe("evaluateFinalOutcome — human escalation OFF (legacy)", () => {
  const off = { ...base, humanEscalationEnabled: false };

  it("conf < threshold → fail-safe dulu", () => {
    expect(evaluateFinalOutcome({ ...off, judgeConfidence: 0.7 })).toEqual({
      kind: "fail_low_confidence",
    });
  });

  it("conf cukup + malicious → override", () => {
    expect(
      evaluateFinalOutcome({ ...off, securityStatus: "malicious" })
    ).toEqual({ kind: "override_malicious" });
  });

  it("conf cukup + bersih → ikut Judge, tanpa needs_human", () => {
    expect(evaluateFinalOutcome(off)).toEqual({ kind: "judge", eligible: true });
  });

  it("sidang berbalik TIDAK eskalasi saat dimatikan", () => {
    expect(
      evaluateFinalOutcome({ ...off, investigatorEligible: false })
    ).toEqual({ kind: "judge", eligible: true });
  });
});
