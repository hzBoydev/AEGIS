// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AegisVault
/// @notice Escrow contract that holds Native BNB temporarily until
///         the AI Oracle (off-chain) verifies the transaction security.
contract AegisVault is ReentrancyGuard {
    enum Status {
        PENDING,
        COMPLETED,
        REVERTED,
        EXPIRED,
        CANCELLED
    }

    /**
     * @notice How long escrows are held before the sender can reclaim the funds.
     *         Fail-safe: if the off-chain oracle dies or stops responding, the funds are not
     *         stuck selamanya.
     */
    uint256 public constant ESCROW_TIMEOUT = 2 hours;

    /**
     * @notice Minimum delay before an oracle change can be accepted.
     *         Transparency window: users have time to exit before the
     *         new oracle goes live.
     */
    uint256 public constant ORACLE_CHANGE_DELAY = 24 hours;

    /**
     * @notice On-chain size limit for `reason` (UTF-8 bytes).
     */
    uint256 public constant MAX_REASON_BYTES = 1024;

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

    /// @notice Oracle candidate from proposeOwner — becomes active after ORACLE_CHANGE_DELAY.
    address public pendingOracle;
    uint256 public oracleChangeReadyAt;

    /// @notice When true: new escrows are not accepted and the oracle cannot decide,
    ///         but users may still withdraw their funds (emergency exit).
    bool public paused;

    mapping(bytes32 => Escrow) private escrows;
    bytes32[] private pendingEscrowIds;
    mapping(bytes32 => uint256) private pendingIndex;

    uint256 private nonce;

    event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount);
    event EscrowReleased(bytes32 indexed escrowId);
    event EscrowReverted(bytes32 indexed escrowId, string reason);
    event EscrowExpired(bytes32 indexed escrowId, address indexed claimer, uint256 amount);
    event EmergencyWithdrawn(bytes32 indexed escrowId, address indexed sender, uint256 amount);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event OracleProposed(address indexed oldOracle, address indexed newOracle, uint256 readyAt);
    event OracleProposalCancelled(address indexed cancelledOracle);
    event ContractPaused(address indexed by);
    event ContractUnpaused(address indexed by);

    error OnlyOracle();
    error OnlyOwner();
    error OnlySender();
    error InvalidRecipient();
    error InvalidAmount();
    error EscrowNotPending();
    error EscrowNotFound();
    error TransferFailed();
    error EscrowTimeout();
    error NotYetExpired();
    error ContractIsPaused();
    error ReasonTooLong();
    error NoPendingOracle();
    error NotPendingOracle();
    error OracleDelayNotElapsed();

    modifier onlyOracle() {
        if (msg.sender != oracle) revert OnlyOracle();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractIsPaused();
        _;
    }

    constructor(address _oracle) {
        require(_oracle != address(0), "Oracle address is not valid");
        oracle = _oracle;
        owner = msg.sender;
    }

    function submitTransfer(address recipient) external payable nonReentrant whenNotPaused returns (bytes32 escrowId) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (msg.value == 0) revert InvalidAmount();

        nonce++;
        escrowId = keccak256(abi.encodePacked(msg.sender, recipient, msg.value, block.timestamp, nonce));

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
        returns (address sender, address recipient, uint256 amount, Status status, uint256 createdAt)
    {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return (e.sender, e.recipient, e.amount, e.status, e.createdAt);
    }

    function fulfillVerification(bytes32 escrowId, bool eligible, string calldata reason)
        external
        onlyOracle
        nonReentrant
        whenNotPaused
    {
        Escrow storage e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        if (e.status != Status.PENDING) revert EscrowNotPending();
        // Past the time limit → only the sender may claim via claimExpired.
        if (block.timestamp >= e.createdAt + ESCROW_TIMEOUT) revert EscrowTimeout();
        if (bytes(reason).length > MAX_REASON_BYTES) revert ReasonTooLong();

        _removeFromPending(escrowId);
        e.reason = reason;

        if (eligible) {
            e.status = Status.COMPLETED;
            (bool ok,) = payable(e.recipient).call{value: e.amount}("");
            if (!ok) revert TransferFailed();
            emit EscrowReleased(escrowId);
        } else {
            e.status = Status.REVERTED;
            (bool ok,) = payable(e.sender).call{value: e.amount}("");
            if (!ok) revert TransferFailed();
            emit EscrowReverted(escrowId, reason);
        }
    }

    function getEscrowStatus(bytes32 escrowId) external view returns (Status status, string memory reason) {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return (e.status, e.reason);
    }

    /// @notice Escrow expiry time (createdAt + ESCROW_TIMEOUT).
    function expiresAt(bytes32 escrowId) external view returns (uint256) {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return e.createdAt + ESCROW_TIMEOUT;
    }

    /// @notice True if the escrow is still PENDING and ESCROW_TIMEOUT has passed.
    function isExpired(bytes32 escrowId) external view returns (bool) {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return e.status == Status.PENDING && block.timestamp >= e.createdAt + ESCROW_TIMEOUT;
    }

    /**
     * @notice Claim the funds of an expired escrow. Permissionless — the funds always
     *         go back to the sender, so anyone may execute this to
     *         preserve liveness (no stuck funds).
     */
    function claimExpired(bytes32 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        if (e.status != Status.PENDING) revert EscrowNotPending();
        if (block.timestamp < e.createdAt + ESCROW_TIMEOUT) revert NotYetExpired();

        _removeFromPending(escrowId);

        address sender = e.sender;
        uint256 amount = e.amount;
        e.status = Status.EXPIRED;
        e.reason = "Escrow expired: oracle did not respond within the time limit";

        (bool ok,) = payable(sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit EscrowExpired(escrowId, msg.sender, amount);
    }

    /**
     * @notice Emergency withdrawal: only applies while the contract is
     *         PAUSED (broken oracle / rotation in progress).
     *         The sender can reclaim their funds without waiting for ESCROW_TIMEOUT.
     * @dev    Funds always return to the sender — the owner can never take user funds.
     */
    function emergencyWithdraw(bytes32 escrowId) external nonReentrant {
        if (!paused) revert ContractIsPaused();

        Escrow storage e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        if (e.status != Status.PENDING) revert EscrowNotPending();
        if (msg.sender != e.sender) revert OnlySender();

        _removeFromPending(escrowId);

        address sender = e.sender;
        uint256 amount = e.amount;
        e.status = Status.CANCELLED;
        e.reason = "Emergency withdrawal: contract is paused";

        (bool ok,) = payable(sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit EmergencyWithdrawn(escrowId, sender, amount);
    }

    // ── Emergency pause ────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    // ── Oracle rotation: two-step + timelock ───────────────────────────────────
    // The owner CANNOT swap the oracle directly — there is a 24 hour delay and it must
    // be accepted by the new oracle address itself (Ownable2Step-style).
    // This closes the SPOF: the oracle key can be rotated with no risk of the owner
    // silently taking over the oracle role.

    function proposeOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidRecipient();
        uint256 readyAt = block.timestamp + ORACLE_CHANGE_DELAY;
        pendingOracle = newOracle;
        oracleChangeReadyAt = readyAt;
        emit OracleProposed(oracle, newOracle, readyAt);
    }

    function cancelOracleProposal() external onlyOwner {
        if (pendingOracle == address(0)) revert NoPendingOracle();
        address cancelled = pendingOracle;
        pendingOracle = address(0);
        oracleChangeReadyAt = 0;
        emit OracleProposalCancelled(cancelled);
    }

    /// @notice Called by the proposed address, once the delay has elapsed.
    function acceptOracle() external {
        if (msg.sender != pendingOracle) revert NotPendingOracle();
        if (block.timestamp < oracleChangeReadyAt) revert OracleDelayNotElapsed();

        address oldOracle = oracle;
        oracle = pendingOracle;
        pendingOracle = address(0);
        oracleChangeReadyAt = 0;

        emit OracleUpdated(oldOracle, oracle);
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
