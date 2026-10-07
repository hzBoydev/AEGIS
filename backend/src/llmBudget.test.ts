import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmBudget, focusedRepassLedgerSize, evidenceRequestReservation } from "./llmBudget.js";

test("budget: starts empty and reports its allowance", () => {
  const b = new LlmBudget(3);
  assert.equal(b.used, 0);
  assert.equal(b.remaining, 3);
  assert.equal(b.exhausted, false);
  assert.equal(b.describe(), "0/3 LLM calls used");
});

test("budget: reservations consume calls one at a time", () => {
  const b = new LlmBudget(2);
  assert.equal(b.tryReserve().ok, true);
  assert.equal(b.used, 1);
  assert.equal(b.remaining, 1);
  assert.equal(b.exhausted, false);
  assert.equal(b.tryReserve().ok, true);
  assert.equal(b.exhausted, true);
});

test("budget: refuses when empty and does not overspend", () => {
  const b = new LlmBudget(1);
  assert.equal(b.tryReserve().ok, true);
  const denied = b.tryReserve();
  assert.equal(denied.ok, false);
  assert.equal(b.used, 1, "a refused reservation must not charge the ledger");
  assert.equal(b.remaining, 0);
});

test("budget: multi-call reservation is all-or-nothing", () => {
  const b = new LlmBudget(3);
  assert.equal(b.tryReserve(2).ok, true);
  const denied = b.tryReserve(2);
  assert.equal(denied.ok, false, "cannot afford 2 of the remaining 1");
  assert.equal(b.used, 2, "the refused pair must not charge 1 call either");
  assert.equal(b.tryReserve(1).ok, true, "the remaining single call is still available");
});

test("budget: two callers cannot both spend the last call", () => {
  const b = new LlmBudget(1);
  const first = b.tryReserve();
  const second = b.tryReserve();
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, "the last call must not be handed out twice");
  assert.equal(b.used, 1);
});

test("budget: reserveOrThrow throws when it cannot pay", () => {
  const b = new LlmBudget(1);
  b.reserveOrThrow();
  assert.throws(() => b.reserveOrThrow(), /exhausted/i);
});

test("budget: zero allowance allows nothing", () => {
  const b = new LlmBudget(0);
  assert.equal(b.exhausted, true);
  assert.equal(b.tryReserve().ok, false);
});

test("budget: rejects a nonsensical allowance", () => {
  assert.throws(() => new LlmBudget(-1), /non-negative/);
  assert.throws(() => new LlmBudget(Number.NaN), /non-negative/);
});

test("budget: release returns min(n,spent) and never negative", () => {
  const b = new LlmBudget(10);
  b.tryReserve(3);
  assert.equal(b.release(100), 3);
  assert.equal(b.used, 0);
  const b2 = new LlmBudget(5);
  assert.equal(b2.release(0), 0);
  assert.equal(b2.release(-1), 0);
  assert.equal(b2.release(NaN), 0);
  assert.equal(b2.release(Infinity), 0);
});

test("budget: release affects state correctly", () => {
  const b = new LlmBudget(10);
  b.tryReserve(5);
  assert.equal(b.release(1), 1);
  assert.equal(b.used, 4);
  assert.equal(b.remaining, 6);
  assert.equal(b.describe(), "4/10 LLM calls used");
});

test("budget: focusedRepassLedgerSize formula", () => {
  assert.equal(focusedRepassLedgerSize(0), 1);
  assert.equal(focusedRepassLedgerSize(1), 2);
  assert.equal(focusedRepassLedgerSize(3), 4);
});

test("budget: evidenceRequestReservation formula", () => {
  assert.equal(evidenceRequestReservation(0), 2);
  assert.equal(evidenceRequestReservation(1), 3);
  assert.equal(evidenceRequestReservation(3), 5);
});
