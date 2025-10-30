pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DbEncryptToolFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public batchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted data storage
    // For simplicity, this example stores a single euint32 per batch.
    // A real database tool would have more complex structures.
    mapping(uint256 => euint32) public encryptedData;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, euint32 encryptedValue);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 decryptedValue);

    error NotOwner();
    error NotProvider();
    error PausedContract();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedContract();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        currentBatchId = 1; // Start with batch 1
        emit BatchOpened(currentBatchId);
        cooldownSeconds = 60; // Default 60 seconds cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert PausedContract(); // Cannot unpause if not paused
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openNewBatch() external onlyOwner {
        currentBatchId++;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId || batchClosed[batchId]) revert InvalidBatchId();
        batchClosed[batchId] = true;
        emit BatchClosed(batchId);
    }

    function submitEncryptedData(euint32 encryptedValue) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchClosed[currentBatchId]) revert BatchClosedOrInvalid();

        lastSubmissionTime[msg.sender] = block.timestamp;
        encryptedData[currentBatchId] = encryptedValue;
        emit DataSubmitted(msg.sender, currentBatchId, encryptedValue);
    }

    function requestDecryptionForBatch(uint256 batchId) external onlyProvider whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchId == 0 || batchId > currentBatchId || !batchClosed[batchId]) revert InvalidBatchId();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 dataToDecrypt = encryptedData[batchId];
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(dataToDecrypt);

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // @dev Replay protection: ensure this callback hasn't been processed for this requestId
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // @dev State verification: ensure the contract state related to the ciphertexts hasn't changed
        // since the decryption was requested. This prevents certain classes of attacks.
        DecryptionContext memory ctx = decryptionContexts[requestId];
        euint32 dataToDecrypt = encryptedData[ctx.batchId];
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(dataToDecrypt);
        bytes32 currentHash = _hashCiphertexts(cts);

        if (currentHash != ctx.stateHash) revert StateMismatch();

        FHE.checkSignatures(requestId, cleartexts, proof);

        // Decode cleartexts in the same order as cts
        uint32 decryptedValue = abi.decode(cleartexts, (uint32));

        ctx.processed = true;
        decryptionContexts[requestId] = ctx; // Update storage

        emit DecryptionCompleted(requestId, ctx.batchId, decryptedValue);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 v) internal view {
        if (!FHE.isInitialized(v)) {
            FHE.asEuint32(0); // Initialize if not already
        }
    }

    function _requireInitialized(euint32 v) internal pure {
        if (!FHE.isInitialized(v)) revert("FHE: euint32 not initialized");
    }
}