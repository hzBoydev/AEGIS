// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AegisVault
/// @notice Escrow contract yang menahan Native BNB sementara sampai
///         AI Oracle (off-chain) memverifikasi keamanan transaksi.
contract AegisVault is ReentrancyGuard {
    enum Status {
        PENDING,
        COMPLETED,
        REVERTED
    }

    struct Escrow {
        address sender;
        address recipient;
        uint256 amount;
        Status status;
        string reason;
        uint256 createdAt;
    }

    address public oracle;
    address public owner;

    mapping(bytes32 => Escrow) private escrows;
    bytes32[] private pendingEscrowIds;
    mapping(bytes32 => uint256) private pendingIndex;

    uint256 private nonce;

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed sender,
        address indexed recipient,
        uint256 amount
    );
    event EscrowReleased(bytes32 indexed escrowId);
    event EscrowReverted(bytes32 indexed escrowId, string reason);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    error OnlyOracle();
    error OnlyOwner();
    error InvalidRecipient();
    error InvalidAmount();
    error EscrowNotPending();
    error EscrowNotFound();
    error TransferFailed();

    modifier onlyOracle() {
        if (msg.sender != oracle) revert OnlyOracle();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _oracle) {
        require(_oracle != address(0), "Oracle address tidak valid");
        oracle = _oracle;
        owner = msg.sender;
    }

    function submitTransfer(address recipient)
        external
        payable
        nonReentrant
        returns (bytes32 escrowId)
    {
        if (recipient == address(0)) revert InvalidRecipient();
        if (msg.value == 0) revert InvalidAmount();

        nonce++;
        escrowId = keccak256(
            abi.encodePacked(msg.sender, recipient, msg.value, block.timestamp, nonce)
        );

        escrows[escrowId] = Escrow({
            sender: msg.sender,
            recipient: recipient,
            amount: msg.value,
            status: Status.PENDING,
            reason: "",
            createdAt: block.timestamp
        });

        pendingEscrowIds.push(escrowId);
        pendingIndex[escrowId] = pendingEscrowIds.length;

        emit EscrowCreated(escrowId, msg.sender, recipient, msg.value);
    }

    function getPendingEscrows() external view returns (bytes32[] memory) {
        return pendingEscrowIds;
    }

    function getEscrowData(bytes32 escrowId)
        external
        view
        returns (
            address sender,
            address recipient,
            uint256 amount,
            Status status,
            uint256 createdAt
        )
    {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return (e.sender, e.recipient, e.amount, e.status, e.createdAt);
    }

    function fulfillVerification(
        bytes32 escrowId,
        bool eligible,
        string calldata reason
    ) external onlyOracle nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        if (e.status != Status.PENDING) revert EscrowNotPending();

        _removeFromPending(escrowId);
        e.reason = reason;

        if (eligible) {
            e.status = Status.COMPLETED;
            (bool ok, ) = payable(e.recipient).call{value: e.amount}("");
            if (!ok) revert TransferFailed();
            emit EscrowReleased(escrowId);
        } else {
            e.status = Status.REVERTED;
            (bool ok, ) = payable(e.sender).call{value: e.amount}("");
            if (!ok) revert TransferFailed();
            emit EscrowReverted(escrowId, reason);
        }
    }

    function getEscrowStatus(bytes32 escrowId)
        external
        view
        returns (Status status, string memory reason)
    {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return (e.status, e.reason);
    }

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "Oracle address tidak valid");
        emit OracleUpdated(oracle, newOracle);
        oracle = newOracle;
    }

    function _removeFromPending(bytes32 escrowId) private {
        uint256 idxPlusOne = pendingIndex[escrowId];
        if (idxPlusOne == 0) return;

        uint256 idx = idxPlusOne - 1;
        uint256 lastIdx = pendingEscrowIds.length - 1;

        if (idx != lastIdx) {
            bytes32 lastId = pendingEscrowIds[lastIdx];
            pendingEscrowIds[idx] = lastId;
            pendingIndex[lastId] = idx + 1;
        }

        pendingEscrowIds.pop();
        delete pendingIndex[escrowId];
    }
}
