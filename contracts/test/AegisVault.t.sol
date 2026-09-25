// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AegisVault.sol";

contract AegisVaultTest is Test {
    AegisVault vault;

    address sender = address(0x1);
    address recipient = address(0x2);
    address oracle = address(0x3);
    address stranger = address(0x4);

    function setUp() public {
        vault = new AegisVault(oracle);
        vm.deal(sender, 10 ether);
    }

    function testSubmitTransferCreatesPendingEscrow() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        (
            address s,
            address r,
            uint256 amount,
            AegisVault.Status status,
            
        ) = vault.getEscrowData(escrowId);

        assertEq(s, sender);
        assertEq(r, recipient);
        assertEq(amount, 1 ether);
        assertEq(uint256(status), uint256(AegisVault.Status.PENDING));

        bytes32[] memory pending = vault.getPendingEscrows();
        assertEq(pending.length, 1);
        assertEq(pending[0], escrowId);
    }

    function testFulfillVerificationReleaseSendsFundsToRecipient() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        uint256 recipientBalanceBefore = recipient.balance;

        vm.prank(oracle);
        vault.fulfillVerification(escrowId, true, "Address aman, riwayat wajar");

        assertEq(recipient.balance, recipientBalanceBefore + 1 ether);

        (AegisVault.Status status, string memory reason) = vault.getEscrowStatus(escrowId);
        assertEq(uint256(status), uint256(AegisVault.Status.COMPLETED));
        assertEq(reason, "Address aman, riwayat wajar");

        bytes32[] memory pending = vault.getPendingEscrows();
        assertEq(pending.length, 0);
    }

    function testFulfillVerificationRevertReturnsFundsToSender() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        uint256 senderBalanceBefore = sender.balance;

        vm.prank(oracle);
        vault.fulfillVerification(escrowId, false, "Address baru, risiko tinggi");

        assertEq(sender.balance, senderBalanceBefore + 1 ether);

        (AegisVault.Status status, string memory reason) = vault.getEscrowStatus(escrowId);
        assertEq(uint256(status), uint256(AegisVault.Status.REVERTED));
        assertEq(reason, "Address baru, risiko tinggi");
    }

    function testOnlyOracleCanFulfillVerification() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vm.prank(stranger);
        vm.expectRevert(AegisVault.OnlyOracle.selector);
        vault.fulfillVerification(escrowId, true, "coba curang");
    }

    function testCannotFulfillVerificationTwice() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vm.prank(oracle);
        vault.fulfillVerification(escrowId, true, "aman");

        vm.prank(oracle);
        vm.expectRevert(AegisVault.EscrowNotPending.selector);
        vault.fulfillVerification(escrowId, true, "coba lagi");
    }

    function testCannotSubmitTransferWithZeroAmount() public {
        vm.prank(sender);
        vm.expectRevert(AegisVault.InvalidAmount.selector);
        vault.submitTransfer{value: 0}(recipient);
    }

    function testCannotSubmitTransferToZeroAddress() public {
        vm.prank(sender);
        vm.expectRevert(AegisVault.InvalidRecipient.selector);
        vault.submitTransfer{value: 1 ether}(address(0));
    }

    function testMultiplePendingEscrowsTrackedCorrectly() public {
        vm.startPrank(sender);
        bytes32 id1 = vault.submitTransfer{value: 1 ether}(recipient);
        bytes32 id2 = vault.submitTransfer{value: 2 ether}(recipient);
        bytes32 id3 = vault.submitTransfer{value: 3 ether}(recipient);
        vm.stopPrank();

        bytes32[] memory pending = vault.getPendingEscrows();
        assertEq(pending.length, 3);

        vm.prank(oracle);
        vault.fulfillVerification(id2, true, "aman");

        pending = vault.getPendingEscrows();
        assertEq(pending.length, 2);

        bool foundId1;
        bool foundId3;
        bool foundId2;
        for (uint256 i = 0; i < pending.length; i++) {
            if (pending[i] == id1) foundId1 = true;
            if (pending[i] == id3) foundId3 = true;
            if (pending[i] == id2) foundId2 = true;
        }
        assertTrue(foundId1);
        assertTrue(foundId3);
        assertFalse(foundId2);
    }

    // ── Oracle rotation: two-step + timelock ───────────────────────────────────

    function testCannotSetOracleInstantlyRemoved() public {
        // setOracle() lama sudah dihapus — rotasi wajib dua langkah.
        (bool ok, ) = address(vault).call(
            abi.encodeWithSignature("setOracle(address)", address(0x5))
        );
        assertFalse(ok);
    }

    function testOracleRotationTwoStep() public {
        address newOracle = address(0x5);

        vault.proposeOracle(newOracle);
        assertEq(vault.pendingOracle(), newOracle);
        assertEq(vault.oracle(), oracle, "oracle lama masih aktif selama delay");

        vm.prank(newOracle);
        vm.expectRevert(AegisVault.OracleDelayNotElapsed.selector);
        vault.acceptOracle();

        vm.warp(block.timestamp + vault.ORACLE_CHANGE_DELAY());

        vm.prank(newOracle);
        vault.acceptOracle();

        assertEq(vault.oracle(), newOracle);
        assertEq(vault.pendingOracle(), address(0));
        assertEq(vault.oracleChangeReadyAt(), 0);
    }

    function testOnlyOwnerCanProposeOracle() public {
        vm.prank(stranger);
        vm.expectRevert(AegisVault.OnlyOwner.selector);
        vault.proposeOracle(address(0x5));
    }

    function testOnlyPendingOracleCanAccept() public {
        vault.proposeOracle(address(0x5));
        vm.warp(block.timestamp + vault.ORACLE_CHANGE_DELAY());

        vm.prank(stranger);
        vm.expectRevert(AegisVault.NotPendingOracle.selector);
        vault.acceptOracle();
    }

    function testCannotProposeZeroOracle() public {
        vm.expectRevert(AegisVault.InvalidRecipient.selector);
        vault.proposeOracle(address(0));
    }

    function testOwnerCanCancelOracleProposal() public {
        vault.proposeOracle(address(0x5));
        vault.cancelOracleProposal();

        assertEq(vault.pendingOracle(), address(0));

        vm.warp(block.timestamp + vault.ORACLE_CHANGE_DELAY());
        vm.prank(address(0x5));
        vm.expectRevert(AegisVault.NotPendingOracle.selector);
        vault.acceptOracle();
    }

    function testCancelOracleProposalRequiresExistingProposal() public {
        vm.expectRevert(AegisVault.NoPendingOracle.selector);
        vault.cancelOracleProposal();
    }

    // ── Emergency pause + withdrawal ───────────────────────────────────────────

    function testPauseBlocksNewSubmissionAndFulfillment() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vault.pause();
        assertTrue(vault.paused());

        vm.prank(sender);
        vm.expectRevert(AegisVault.ContractIsPaused.selector);
        vault.submitTransfer{value: 1 ether}(recipient);

        vm.prank(oracle);
        vm.expectRevert(AegisVault.ContractIsPaused.selector);
        vault.fulfillVerification(escrowId, true, "aman");
    }

    function testEmergencyWithdrawRefundsSenderWhilePaused() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        // Belum pause → tidak boleh emergency withdraw.
        vm.prank(sender);
        vm.expectRevert(AegisVault.ContractIsPaused.selector);
        vault.emergencyWithdraw(escrowId);

        vault.pause();

        // Oracle juga tidak boleh memutuskan saat pause.
        vm.prank(oracle);
        vm.expectRevert(AegisVault.ContractIsPaused.selector);
        vault.fulfillVerification(escrowId, true, "tetap jalan");

        uint256 senderBalanceBefore = sender.balance;
        vm.prank(sender);
        vault.emergencyWithdraw(escrowId);

        assertEq(sender.balance, senderBalanceBefore + 1 ether);

        (AegisVault.Status status, ) = vault.getEscrowStatus(escrowId);
        assertEq(uint256(status), uint256(AegisVault.Status.CANCELLED));

        bytes32[] memory pending = vault.getPendingEscrows();
        assertEq(pending.length, 0);
    }

    function testEmergencyWithdrawOnlySender() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vault.pause();

        vm.prank(stranger);
        vm.expectRevert(AegisVault.OnlySender.selector);
        vault.emergencyWithdraw(escrowId);

        vm.prank(recipient);
        vm.expectRevert(AegisVault.OnlySender.selector);
        vault.emergencyWithdraw(escrowId);
    }

    function testCannotEmergencyWithdrawFinalizedEscrow() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vm.prank(oracle);
        vault.fulfillVerification(escrowId, true, "aman");

        vault.pause();

        vm.prank(sender);
        vm.expectRevert(AegisVault.EscrowNotPending.selector);
        vault.emergencyWithdraw(escrowId);
    }

    function testUnpauseRestoresNormalFlow() public {
        vault.pause();
        vault.unpause();
        assertFalse(vault.paused());

        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vm.prank(oracle);
        vault.fulfillVerification(escrowId, true, "aman");

        (AegisVault.Status status, ) = vault.getEscrowStatus(escrowId);
        assertEq(uint256(status), uint256(AegisVault.Status.COMPLETED));
    }

    function testOnlyOwnerCanPause() public {
        vm.prank(stranger);
        vm.expectRevert(AegisVault.OnlyOwner.selector);
        vault.pause();

        vm.prank(stranger);
        vm.expectRevert(AegisVault.OnlyOwner.selector);
        vault.unpause();
    }

    function testClaimExpiredStillWorksWhilePaused() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vault.pause();
        vm.warp(block.timestamp + vault.ESCROW_TIMEOUT());

        uint256 senderBalanceBefore = sender.balance;
        vm.prank(sender);
        vault.claimExpired(escrowId);
        assertEq(sender.balance, senderBalanceBefore + 1 ether);
    }

    // ── Batas ukuran reason ────────────────────────────────────────────────────

    function testFulfillRejectsOverlongReason() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        bytes memory tooLong = new bytes(vault.MAX_REASON_BYTES() + 1);

        vm.prank(oracle);
        vm.expectRevert(AegisVault.ReasonTooLong.selector);
        vault.fulfillVerification(escrowId, true, string(tooLong));
    }

    function testFulfillAcceptsMaxReasonLength() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        bytes memory maxReason = new bytes(vault.MAX_REASON_BYTES());

        vm.prank(oracle);
        vault.fulfillVerification(escrowId, false, string(maxReason));

        (AegisVault.Status status, string memory reason) = vault.getEscrowStatus(escrowId);
        assertEq(uint256(status), uint256(AegisVault.Status.REVERTED));
        assertEq(bytes(reason).length, vault.MAX_REASON_BYTES());
    }
    // ── Escrow timeout / expiry ────────────────────────────────────────────────

    function testEscrowNotExpiredBeforeTimeout() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        assertFalse(vault.isExpired(escrowId));
        assertEq(
            vault.expiresAt(escrowId),
            vault.ESCROW_TIMEOUT() + escrowDataCreatedAt(escrowId)
        );

        vm.warp(block.timestamp + vault.ESCROW_TIMEOUT() - 1);
        assertFalse(vault.isExpired(escrowId));
    }

    function testClaimExpiredRefundsSenderAfterTimeout() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vm.warp(block.timestamp + vault.ESCROW_TIMEOUT());
        assertTrue(vault.isExpired(escrowId));

        uint256 senderBalanceBefore = sender.balance;
        vm.prank(stranger);
        vault.claimExpired(escrowId);

        assertEq(sender.balance, senderBalanceBefore + 1 ether);

        (AegisVault.Status status, string memory reason) = vault.getEscrowStatus(escrowId);
        assertEq(uint256(status), uint256(AegisVault.Status.EXPIRED));
        assertTrue(bytes(reason).length > 0);

        bytes32[] memory pending = vault.getPendingEscrows();
        assertEq(pending.length, 0);
    }

    function testCannotClaimExpiredBeforeTimeout() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vm.warp(block.timestamp + vault.ESCROW_TIMEOUT() - 1);
        vm.prank(sender);
        vm.expectRevert(AegisVault.NotYetExpired.selector);
        vault.claimExpired(escrowId);
    }

    function testCannotClaimExpiredTwice() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vm.warp(block.timestamp + vault.ESCROW_TIMEOUT());
        vm.prank(sender);
        vault.claimExpired(escrowId);

        vm.prank(sender);
        vm.expectRevert(AegisVault.EscrowNotPending.selector);
        vault.claimExpired(escrowId);
    }

    function testOracleCannotFulfillAfterExpiry() public {
        vm.prank(sender);
        bytes32 escrowId = vault.submitTransfer{value: 1 ether}(recipient);

        vm.warp(block.timestamp + vault.ESCROW_TIMEOUT());

        vm.prank(oracle);
        vm.expectRevert(AegisVault.EscrowTimeout.selector);
        vault.fulfillVerification(escrowId, true, "terlambat");

        // Dana tetap bisa diklaim sender.
        vm.prank(sender);
        vault.claimExpired(escrowId);

        (AegisVault.Status status, ) = vault.getEscrowStatus(escrowId);
        assertEq(uint256(status), uint256(AegisVault.Status.EXPIRED));
    }

    function testCannotClaimExpiredForUnknownEscrow() public {
        bytes32 bogus = keccak256("does-not-exist");
        vm.expectRevert(AegisVault.EscrowNotFound.selector);
        vault.claimExpired(bogus);
    }

    function escrowDataCreatedAt(bytes32 escrowId) internal view returns (uint256 createdAt) {
        (, , , , createdAt) = vault.getEscrowData(escrowId);
    }
}
