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

    function testOnlyOwnerCanUpdateOracle() public {
        address newOracle = address(0x5);

        vm.prank(stranger);
        vm.expectRevert(AegisVault.OnlyOwner.selector);
        vault.setOracle(newOracle);

        vault.setOracle(newOracle);
        assertEq(vault.oracle(), newOracle);
    }
}
