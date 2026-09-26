import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { buildVoteMessage, verifyVote } from "../src/voteAuth.js";
import { TEST_ADDRESS_0, TEST_ADDRESS_1, TEST_ESCROW_ID, TEST_KEY_0 } from "./constants.js";

const voter = privateKeyToAccount(TEST_KEY_0);

async function signedVote(over: Partial<Parameters<typeof buildVoteMessage>[0]> = {}) {
  const input = {
    voter: TEST_ADDRESS_0,
    escrowId: TEST_ESCROW_ID,
    approve: true,
    timestamp: Date.now(),
    ...over,
  };
  const signature = await voter.signMessage({ message: buildVoteMessage(input) });
  return { ...input, signature };
}

describe("buildVoteMessage", () => {
  it("kanonik dan deterministik", () => {
    const msg = buildVoteMessage({
      voter: TEST_ADDRESS_0,
      escrowId: TEST_ESCROW_ID,
      approve: false,
      timestamp: 1_700_000_000_000,
    });
    expect(msg).toBe(
      [
        "AEGIS Human Review Vote v1",
        "Chain-Id: 97",
        `Escrow-Id: ${TEST_ESCROW_ID}`,
        "Action: REJECT",
        `Voter: ${TEST_ADDRESS_0.toLowerCase()}`,
        "Timestamp: 1700000000000",
      ].join("\n")
    );
  });

  it("approve vs reject memberi pesan berbeda", () => {
    const common = {
      voter: TEST_ADDRESS_0,
      escrowId: TEST_ESCROW_ID,
      timestamp: 1,
    };
    expect(buildVoteMessage({ ...common, approve: true })).not.toBe(
      buildVoteMessage({ ...common, approve: false })
    );
  });
});

describe("verifyVote", () => {
  it("signature sah dari reviewer terdaftar → ok", async () => {
    const vote = await signedVote();
    const result = await verifyVote(vote);
    expect(result.ok).toBe(true);
    expect(result.voter?.toLowerCase()).toBe(TEST_ADDRESS_0.toLowerCase());
  });

  it("REJECT vote juga sah", async () => {
    const vote = await signedVote({ approve: false });
    expect((await verifyVote(vote)).ok).toBe(true);
  });

  it("signature atas pesan berbeda → bad_signature", async () => {
    const vote = await signedVote();
    const forged = await voter.signMessage({ message: "pesan lain" });
    const result = await verifyVote({ ...vote, signature: forged });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("bad_signature");
  });

  it("timestamp kadaluarsa → expired_timestamp", async () => {
    const vote = await signedVote({ timestamp: Date.now() - 3_600_000 });
    const result = await verifyVote(vote);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("expired_timestamp");
  });

  it("timestamp di masa depan jauh → expired_timestamp", async () => {
    const vote = await signedVote({ timestamp: Date.now() + 3_600_000 });
    const result = await verifyVote(vote);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("expired_timestamp");
  });

  it("address di luar allowlist → not_reviewer", async () => {
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
    );
    const input = {
      voter: TEST_ADDRESS_1,
      escrowId: TEST_ESCROW_ID,
      approve: true,
      timestamp: Date.now(),
    };
    const signature = await other.signMessage({
      message: buildVoteMessage(input),
    });
    const result = await verifyVote({ ...input, signature });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("not_reviewer");
  });

  it("voter bukan address valid → bad_payload", async () => {
    const vote = await signedVote();
    const result = await verifyVote({ ...vote, voter: "0x123" });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("bad_payload");
  });

  it("escrowId berbeda dari yang ditandatangani → bad_signature", async () => {
    const vote = await signedVote();
    const result = await verifyVote({
      ...vote,
      escrowId: "0x2222222222222222222222222222222222222222222222222222222222222222",
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("bad_signature");
  });
});
