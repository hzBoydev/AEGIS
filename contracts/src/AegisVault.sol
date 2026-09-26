// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title AegisVault
/// @notice Escrow contract yang menahan Native BNB sementara sampai
///         AI Oracle (off-chain) memverifikasi keamanan transaksi.
/// @dev    Prinsip keamanan:
///         - Semua perpindahan dana memakai checks-effects-interactions + nonReentrant.
///         - Dana HANYA bisa keluar ke `sender` atau `recipient` — owner tidak bisa
///           menarik dana user.
///         - Gagal total selalu punya jalur keluar: `claimExpired` (permissionless,
///           setelah ESCROW_TIMEOUT) dan `cancelEscrow` (oleh sender, sebelum timeout).
///         - Pergantian owner memakai two-step (Ownable2Step); pergantian oracle
///           two-step + timelock 24 jam.
contract AegisVault is ReentrancyGuard, Ownable2Step {
    /// @notice Status lifecycle sebuah escrow.
    enum Status {
        PENDING, // menunggu keputusan oracle
        COMPLETED, // dana sudah dikirim ke penerima
        REVERTED, // dana dikembalikan ke pengirim (keputusan oracle: tidak aman)
        EXPIRED, // kedaluwarsa, dana diklaim kembali
        CANCELLED // dibatalkan pengirim / emergency withdraw
    }

    /// @notice Data escrow yang disimpan on-chain.
    /// @dev `reason` diisi oleh oracle (hasil sidang) atau teks pembatalan.
    struct Escrow {
        address sender;
        address recipient;
        uint256 amount;
        Status status;
        string reason;
        uint256 createdAt;
    }

    /**
     * @notice Batas waktu escrow ditahan sebelum bisa diklaim kembali oleh sender.
     * @dev    Fail-safe: kalau oracle off-chain mati/tidak merespons, dana tidak
     *         stuck selamanya.
     */
    uint256 public constant ESCROW_TIMEOUT = 2 hours;

    /**
     * @notice Jeda minimum sebelum pergantian oracle bisa di-accept.
     * @dev    Jendela transparansi: pengguna punya waktu keluar sebelum
     *         oracle baru aktif.
     */
    uint256 public constant ORACLE_CHANGE_DELAY = 24 hours;

    /// @notice Batas ukuran `reason` on-chain (bytes UTF-8).
    uint256 public constant MAX_REASON_BYTES = 1024;

    /// @notice Address oracle aktif — satu-satunya yang boleh memutuskan escrow.
    address public oracle;

    /// @notice Kandidat oracle hasil `proposeOracle` — aktif setelah ORACLE_CHANGE_DELAY.
    address public pendingOracle;

    /// @notice Timestamp kapan `pendingOracle` boleh memanggil `acceptOracle`.
    uint256 public oracleChangeReadyAt;

    /// @notice Saat true: escrow baru tidak diterima & oracle tidak bisa memutuskan,
    ///         tapi sender tetap boleh mengambil dananya (emergency exit).
    bool public paused;

    mapping(bytes32 => Escrow) private escrows;
    bytes32[] private pendingEscrowIds;
    mapping(bytes32 => uint256) private pendingIndex;
    uint256 private nonce;

    /// @notice Escrow baru dibuat oleh sender.
    event EscrowCreated(bytes32 indexed escrowId, address indexed sender, address indexed recipient, uint256 amount);
    /// @notice Oracle memutuskan escrow layak diteruskan → dana ke penerima.
    event EscrowReleased(bytes32 indexed escrowId);
    /// @notice Oracle memutuskan escrow ditolak → dana kembali ke pengirim.
    event EscrowReverted(bytes32 indexed escrowId, string reason);
    /// @notice Escrow kedaluwarsa dan diklaim kembali oleh siapa pun.
    event EscrowExpired(bytes32 indexed escrowId, address indexed claimer, uint256 amount);
    /// @notice Sender membatalkan escrownya sendiri sebelum ESCROW_TIMEOUT.
    event EscrowCancelled(bytes32 indexed escrowId, address indexed sender, uint256 amount);
    /// @notice Pengambilan dana darurat saat kontrak dalam keadaan pause.
    event EmergencyWithdrawn(bytes32 indexed escrowId, address indexed sender, uint256 amount);
    /// @notice Rotasi oracle selesai (oleh oracle baru sendiri).
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    /// @notice Owner mengusulkan oracle baru; berlaku setelah ORACLE_CHANGE_DELAY.
    event OracleProposed(address indexed oldOracle, address indexed newOracle, uint256 readyAt);
    /// @notice Owner membatalkan usulan rotasi oracle.
    event OracleProposalCancelled(address indexed cancelledOracle);
    /// @notice Owner mengaktifkan pause darurat.
    event ContractPaused(address indexed by);
    /// @notice Owner menonaktifkan pause.
    event ContractUnpaused(address indexed by);

    error OnlyOracle();
    error OnlySender();
    error InvalidRecipient();
    error InvalidOracle();
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
    error InvalidPage();

    /// @dev Hanya address `oracle` aktif.
    modifier onlyOracle() {
        if (msg.sender != oracle) revert OnlyOracle();
        _;
    }

    /// @dev Blokir operasi escrow selama pause darurat.
    modifier whenNotPaused() {
        if (paused) revert ContractIsPaused();
        _;
    }

    /// @param _oracle Address oracle awal (off-chain signer AEGIS).
    /// @dev    Owner = `msg.sender` (deployer); rotasi owner two-step via Ownable2Step.
    constructor(address _oracle) Ownable(msg.sender) {
        if (_oracle == address(0)) revert InvalidOracle();
        oracle = _oracle;
    }

    // ── Escrow lifecycle ───────────────────────────────────────────────────────

    /// @notice Buat escrow baru yang menahan `msg.value` BNB sampai oracle memutuskan.
    /// @param recipient Address penerima dana bila escrow diteruskan.
    /// @return escrowId Identifier unik escrow (keccak dari parameter + nonce).
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

    /// @notice Keputusan oracle: teruskan dana ke penerima, atau kembalikan ke pengirim.
    /// @param escrowId Escrow yang sedang PENDING.
    /// @param eligible  true → bayar ke penerima; false → refund ke pengirim.
    /// @param reason    Alasan keputusan (maksimal MAX_REASON_BYTES bytes UTF-8).
    function fulfillVerification(bytes32 escrowId, bool eligible, string calldata reason)
        external
        onlyOracle
        nonReentrant
        whenNotPaused
    {
        Escrow storage e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        if (e.status != Status.PENDING) revert EscrowNotPending();
        // Lewat batas waktu → hanya sender yang boleh mengambil via claimExpired.
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

    /// @notice Batalkan escrow milik sendiri sebelum ESCROW_TIMEOUT (self-serve).
    /// @dev    Hanya sender; dana kembali 100% ke sender. Tidak bisa dipakai setelah
    ///         oracle memutuskan (status sudah bukan PENDING).
    /// @param escrowId Escrow milik `msg.sender` yang masih PENDING.
    function cancelEscrow(bytes32 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        if (e.status != Status.PENDING) revert EscrowNotPending();
        if (msg.sender != e.sender) revert OnlySender();
        if (block.timestamp >= e.createdAt + ESCROW_TIMEOUT) revert EscrowTimeout();

        _removeFromPending(escrowId);

        address sender = e.sender;
        uint256 amount = e.amount;
        e.status = Status.CANCELLED;
        e.reason = "Dibatalkan oleh pengirim sebelum escrow diputuskan";

        (bool ok,) = payable(sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit EscrowCancelled(escrowId, sender, amount);
    }

    /// @notice Klaim dana escrow yang kedaluwarsa.
    /// @dev    Permissionless — dana selalu dikembalikan ke sender, jadi siapa pun
    ///         boleh mengeksekusi untuk menjaga liveness (anti stuck dana).
    /// @param escrowId Escrow yang sudah melewati ESCROW_TIMEOUT.
    function claimExpired(bytes32 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        if (e.status != Status.PENDING) revert EscrowNotPending();
        if (block.timestamp < e.createdAt + ESCROW_TIMEOUT) revert NotYetExpired();

        _removeFromPending(escrowId);

        address sender = e.sender;
        uint256 amount = e.amount;
        e.status = Status.EXPIRED;
        e.reason = "Escrow kedaluwarsa: oracle tidak merespons dalam batas waktu";

        (bool ok,) = payable(sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit EscrowExpired(escrowId, msg.sender, amount);
    }

    /// @notice Emergency withdrawal: hanya berlaku saat kontrak PAUSED
    ///         (oracle bermasalah / rotasi sedang berlangsung).
    /// @dev    Dana selalu kembali ke sender — owner tidak bisa mengambil dana user.
    /// @param escrowId Escrow milik `msg.sender` yang masih PENDING.
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
        e.reason = "Emergency withdrawal: kontrak dalam masa pause";

        (bool ok,) = payable(sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit EmergencyWithdrawn(escrowId, sender, amount);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    /// @notice Semua escrow yang masih PENDING.
    /// @dev    Kembalikan seluruh array — untuk dataset besar pakai
    ///         `getPendingEscrowsPage` agar tidak melewati batas gas eth_call.
    function getPendingEscrows() external view returns (bytes32[] memory) {
        return pendingEscrowIds;
    }

    /// @notice Halaman escrow PENDING (paging O(1) per item).
    /// @param offset Index awal (0-based).
    /// @param limit  Maksimal item yang dikembalikan.
    /// @return ids   Slice `pendingEscrowIds[offset : offset + limit]`.
    function getPendingEscrowsPage(uint256 offset, uint256 limit) external view returns (bytes32[] memory ids) {
        uint256 total = pendingEscrowIds.length;
        if (offset > total || offset + limit > total) revert InvalidPage();

        ids = new bytes32[](limit);
        for (uint256 i = 0; i < limit; i++) {
            ids[i] = pendingEscrowIds[offset + i];
        }
    }

    /// @notice Data dasar sebuah escrow.
    /// @param escrowId Identifier escrow.
    /// @return sender    Pengirim (tempat dana kembali bila gagal).
    /// @return recipient Penerima (tempat dana pergi bila diteruskan).
    /// @return amount    Nilai escrow dalam wei.
    /// @return status    Status lifecycle saat ini.
    /// @return createdAt Timestamp pembuatan.
    function getEscrowData(bytes32 escrowId)
        external
        view
        returns (address sender, address recipient, uint256 amount, Status status, uint256 createdAt)
    {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return (e.sender, e.recipient, e.amount, e.status, e.createdAt);
    }

    /// @notice Status dan alasan keputusan sebuah escrow.
    /// @param escrowId Identifier escrow.
    /// @return status Status lifecycle saat ini.
    /// @return reason Alasan keputusan/pembatalan (kosong bila belum diputuskan).
    function getEscrowStatus(bytes32 escrowId) external view returns (Status status, string memory reason) {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return (e.status, e.reason);
    }

    /// @notice Waktu kedaluwarsa escrow (createdAt + ESCROW_TIMEOUT).
    /// @param escrowId Identifier escrow.
    /// @return Timestamp kedaluwarsa.
    function expiresAt(bytes32 escrowId) external view returns (uint256) {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return e.createdAt + ESCROW_TIMEOUT;
    }

    /// @notice True jika escrow masih PENDING dan sudah lewat ESCROW_TIMEOUT.
    /// @param escrowId Identifier escrow.
    /// @return Sudah kedaluwarsa atau belum.
    function isExpired(bytes32 escrowId) external view returns (bool) {
        Escrow memory e = escrows[escrowId];
        if (e.sender == address(0)) revert EscrowNotFound();
        return e.status == Status.PENDING && block.timestamp >= e.createdAt + ESCROW_TIMEOUT;
    }

    // ── Emergency pause ────────────────────────────────────────────────────────

    /// @notice Aktifkan pause darurat: blokir submit/fulfill, buka jalur emergency.
    function pause() external onlyOwner {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    /// @notice Nonaktifkan pause; operasi escrow kembali normal.
    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    // ── Oracle rotation: two-step + timelock ───────────────────────────────────
    // Owner TIDAK BISA langsung mengganti oracle — ada jeda 24 jam dan wajib
    // di-accept oleh address oracle baru itu sendiri.
    // Ini menutup SPOF: key oracle bisa dirotasi tanpa risiko owner mengambil
    // alih peran oracle secara diam-diam.

    /// @notice Usulkan oracle baru; aktif setelah ORACLE_CHANGE_DELAY.
    /// @param newOracle Address kandidat oracle (harus nonzero).
    function proposeOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidOracle();
        uint256 readyAt = block.timestamp + ORACLE_CHANGE_DELAY;
        pendingOracle = newOracle;
        oracleChangeReadyAt = readyAt;
        emit OracleProposed(oracle, newOracle, readyAt);
    }

    /// @notice Batalkan usulan rotasi oracle yang sedang berjalan.
    function cancelOracleProposal() external onlyOwner {
        if (pendingOracle == address(0)) revert NoPendingOracle();
        address cancelled = pendingOracle;
        pendingOracle = address(0);
        oracleChangeReadyAt = 0;
        emit OracleProposalCancelled(cancelled);
    }

    /// @notice Dipanggil oleh address hasil propose, setelah jeda tercapai.
    function acceptOracle() external {
        if (msg.sender != pendingOracle) revert NotPendingOracle();
        if (block.timestamp < oracleChangeReadyAt) revert OracleDelayNotElapsed();

        address oldOracle = oracle;
        oracle = pendingOracle;
        pendingOracle = address(0);
        oracleChangeReadyAt = 0;

        emit OracleUpdated(oldOracle, oracle);
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    /// @dev Hapus escrow dari antrian pending (swap-and-pop, O(1)).
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
