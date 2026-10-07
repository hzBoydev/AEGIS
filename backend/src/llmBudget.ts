// ── Per-escrow LLM call budget ─────────────────────────────────────────────────
// WHY a global counter at all
// ──────────────────────────
// The per-agent caps (`AGENT_MAX_STEPS`, `ADVOCATE_MAX_STEPS`,
// `AGENT_MAX_FOLLOWUP_STEPS`) bound each agent *in isolation*. On their own they
// do not bound the escrow: Investigator (5) + Advocate (3) + Judge #1 (1) +
// focused re-pass (2) + Judge #2 (1) = 12 calls, and any one of those numbers can
// be raised by configuration without the others moving. On a single 6GB GPU that
// is not an abstract concern — it is the difference between an escrow that
// answers in a minute and one that holds the serialization queue for ten,
// starving every other escrow behind it.
//
// So the escrow itself gets a hard ceiling, and every LLM call in the pipeline
// must reserve from it before it runs. The counter is a reservation ledger, not a
// usage tally: a call is charged the moment it is *allowed to start*, so two
// agents cannot both observe "1 left" and both spend it.
//
// The reservation that matters most is the evidence-request path. It is the last
// thing in the pipeline and therefore the easiest to overrun — which is exactly why
// the focused re-pass RESERVES ITSELF AND Judge #2 TOGETHER, up front and in full
// (`evidenceRequestReservation()`). Reserving only the re-pass was a real defect:
// the worst case is re-pass + Judge #2, so a reservation one call short let the
// final call of the escrow run for free. If the pair does not fit, the re-pass is
// skipped and the Judge is asked for a ruling without the option, rather than
// running a re-pass that provably cannot be concluded. Whatever the pair does not
// spend is handed back with `release()`, so the escrow total stays a count of calls
// that actually happened.

import { config } from "./config.js";

/** Reason a reservation was denied — logged, never silently swallowed. */
export type BudgetDenial = "exhausted";

export class LlmBudget {
  private spent = 0;

  constructor(readonly maxCalls: number) {
    if (!Number.isFinite(maxCalls) || maxCalls < 0) {
      throw new Error(`LlmBudget: maxCalls must be a non-negative number, got ${maxCalls}`);
    }
  }

  /** LLM calls already charged to this escrow. */
  get used(): number {
    return this.spent;
  }

  /** Calls still available. */
  get remaining(): number {
    return this.maxCalls - this.spent;
  }

  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  /**
   * Charge `calls` to the budget, or refuse.
   *
   * All-or-nothing: a partial charge would leave the ledger describing calls that
   * never happened, which is precisely the kind of drift that lets a later agent
   * believe it has room it does not have.
   */
  tryReserve(calls = 1): { ok: true } | { ok: false; reason: BudgetDenial; remaining: number } {
    if (this.remaining < calls) {
      return { ok: false, reason: "exhausted", remaining: this.remaining };
    }
    this.spent += calls;
    return { ok: true };
  }

  /**
   * Reserve, or throw — for call sites where proceeding without the call would be
   * a programming error rather than a runtime condition.
   */
  reserveOrThrow(calls = 1): void {
    const r = this.tryReserve(calls);
    if (!r.ok) {
      throw new Error(
        `LlmBudget exhausted: needed ${calls} call(s), ${r.remaining} left of ${this.maxCalls}`
      );
    }
  }

  /**
   * Hand back `calls` reserved-but-unused allowance. Returns how much was
   * actually returned.
   *
   * Needed because the pipeline reserves the re-pass AND Judge #2 TOGETHER, before
   * it knows how many of those calls the re-pass will really spend (it may answer
   * on its first round, or the re-pass may throw after one). Without this the
   * escrow's telemetry would report calls that never happened, and a ledger that
   * over-reports is indistinguishable from one that over-spent — so the ceiling
   * would lose the meaning it exists to give.
   *
   * Bounded by what was actually charged: a release can never mint allowance out
   * of nothing, and `maxCalls` stays the hard ceiling.
   */
  release(calls = 1): number {
    if (!Number.isFinite(calls) || calls <= 0) return 0;
    const n = Math.min(Math.floor(calls), this.spent);
    this.spent -= n;
    return n;
  }

  /** One-line state for the transcript/DB. */
  describe(): string {
    return `${this.spent}/${this.maxCalls} LLM calls used`;
  }
}

/**
 * Worst-case LLM calls ONE focused re-pass agent run can make.
 *
 * `AGENT_MAX_FOLLOWUP_STEPS` tool rounds plus the forced final call the loop always
 * gets — the same `maxSteps + 1` arithmetic every other agent obeys, derived rather
 * than hard-coded so raising the cap in config moves this number with it. 
 *
 * `maxSteps = 0` means "one call, no tools", so it still costs 1.
 */
export function focusedRepassLedgerSize(
  maxFollowupSteps: number = config.AGENT_MAX_FOLLOWUP_STEPS
): number {
  const n = Math.max(0, Math.floor(maxFollowupSteps));
  return n + 1;
}

/**
 * The Judge's second ruling — exactly one direct `callJudge` call.
 *
 * It shares the reservation with the re-pass on purpose (see `runSecurityPipeline`):
 * a re-pass whose conclusion nobody can judge leaves the hearing in a state nobody
 * is accountable for, so the two are affordable only as a pair.
 */
export const JUDGE_REDECISION_CALLS = 1;

/**
 * The true worst case of the evidence-request path: the whole re-pass plus Judge #2.
 * This is the number the escrow budget must be able to reserve atomically before any
 * of it runs.
 */
export function evidenceRequestReservation(
  maxFollowupSteps: number = config.AGENT_MAX_FOLLOWUP_STEPS
): number {
  return focusedRepassLedgerSize(maxFollowupSteps) + JUDGE_REDECISION_CALLS;
}

/**
 * A budget sized from config, for callers that should not have to think about it.
 */
export function createEscrowBudget(maxCalls: number = config.AGENT_MAX_LLM_CALLS): LlmBudget {
  return new LlmBudget(maxCalls);
}