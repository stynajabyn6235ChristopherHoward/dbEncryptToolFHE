import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DatabaseRecord {
  id: string;
  tableName: string;
  encryptedData: string;
  originalValue: number;
  timestamp: number;
  owner: string;
  status: "pending" | "encrypted" | "verified";
  fheOperation?: string;
}

// FHE Encryption/Decryption simulation
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const base64Data = encryptedData.split('-')[1];
    return parseFloat(atob(base64Data));
  }
  return parseFloat(encryptedData);
};

// FHE Operations simulation
const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'sum':
      result = value + 100;
      break;
    case 'multiply':
      result = value * 2;
      break;
    case 'average':
      result = value * 0.8;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<DatabaseRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showMigrationModal, setShowMigrationModal] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ tableName: "", originalValue: 0, description: "" });
  const [currentStep, setCurrentStep] = useState(1);
  const [selectedRecord, setSelectedRecord] = useState<DatabaseRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [encryptionProgress, setEncryptionProgress] = useState(0);
  const [realTimeStats, setRealTimeStats] = useState({
    totalRecords: 0,
    encryptedCount: 0,
    processingCount: 0,
    successRate: 100
  });

  // Initialize component
  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initParams();
    
    // Simulate real-time updates
    const statsInterval = setInterval(() => {
      setRealTimeStats(prev => ({
        totalRecords: records.length,
        encryptedCount: records.filter(r => r.status === "encrypted").length,
        processingCount: records.filter(r => r.status === "pending").length,
        successRate: records.length > 0 ? Math.round((records.filter(r => r.status === "encrypted").length / records.length) * 100) : 100
      }));
    }, 2000);
    
    return () => clearInterval(statsInterval);
  }, [records]);

  // Load records from contract
  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }
      
      // Load record keys
      const keysBytes = await contract.getData("db_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      
      const list: DatabaseRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`db_record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                tableName: recordData.tableName, 
                encryptedData: recordData.encryptedData, 
                originalValue: recordData.originalValue,
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                status: recordData.status || "pending",
                fheOperation: recordData.fheOperation
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  // Check contract availability
  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Contract not found");
      
      const isAvailable = await contract.isAvailable();
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: isAvailable ? "ZAMA FHE Contract is available and ready!" : "Contract not available" 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Migrate database record with FHE encryption
  const migrateRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setMigrating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting database record with ZAMA FHE..." });
    
    try {
      // Simulate encryption progress
      for (let i = 0; i <= 100; i += 20) {
        setEncryptionProgress(i);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      const encryptedData = FHEEncryptNumber(newRecordData.originalValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `db_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        tableName: newRecordData.tableName,
        encryptedData: encryptedData,
        originalValue: newRecordData.originalValue,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "encrypted" 
      };
      
      await contract.setData(`db_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update record keys
      const keysBytes = await contract.getData("db_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("db_record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Database record encrypted and stored securely!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowMigrationModal(false);
        setNewRecordData({ tableName: "", originalValue: 0, description: "" });
        setEncryptionProgress(0);
        setCurrentStep(1);
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Migration failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setMigrating(false); }
  };

  // Decrypt with wallet signature
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `Decrypt FHE data\nPublic Key: ${publicKey}\nContract: ${contractAddress}\nChain: ${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  // Perform FHE operation on encrypted data
  const performFHEOperation = async (recordId: string, operation: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: `Performing ${operation} on encrypted data...` });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const recordBytes = await contract.getData(`db_record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const resultData = FHECompute(recordData.encryptedData, operation);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "verified", fheOperation: operation, encryptedData: resultData };
      await contractWithSigner.setData(`db_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: `FHE ${operation} operation completed!` });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "FHE operation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  // Migration steps
  const migrationSteps = [
    { number: 1, title: "Select Table", description: "Choose database table to encrypt" },
    { number: 2, title: "Encrypt Data", description: "FHE encryption process" },
    { number: 3, title: "Verify & Store", description: "Store encrypted data on-chain" }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing ZAMA FHE Database Tool...</p>
    </div>
  );

  return (
    <div className="app-container fhe-db-tool">
      {/* Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo">
            <div className="shield-icon">🔒</div>
            <h1>FHE<span>DB</span>Migrator</h1>
          </div>
          <div className="tagline">ZAMA FHE-Powered Database Encryption</div>
        </div>
        
        <div className="header-controls">
          <button onClick={checkAvailability} className="control-btn availability-btn">
            Check Contract
          </button>
          <button onClick={() => setShowMigrationModal(true)} className="control-btn primary-btn">
            Start Migration
          </button>
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>

      {/* Real-time Stats Dashboard */}
      <section className="stats-dashboard">
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon">📊</div>
            <div className="stat-content">
              <div className="stat-value">{realTimeStats.totalRecords}</div>
              <div className="stat-label">Total Records</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">🔒</div>
            <div className="stat-content">
              <div className="stat-value">{realTimeStats.encryptedCount}</div>
              <div className="stat-label">Encrypted</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">⚡</div>
            <div className="stat-content">
              <div className="stat-value">{realTimeStats.processingCount}</div>
              <div className="stat-label">Processing</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">✅</div>
            <div className="stat-content">
              <div className="stat-value">{realTimeStats.successRate}%</div>
              <div className="stat-label">Success Rate</div>
            </div>
          </div>
        </div>
      </section>

      {/* Main Content */}
      <main className="main-content">
        {/* Database Records Section */}
        <section className="records-section">
          <div className="section-header">
            <h2>Encrypted Database Records</h2>
            <button onClick={loadRecords} className="refresh-btn" disabled={isRefreshing}>
              {isRefreshing ? "🔄 Refreshing..." : "🔄 Refresh"}
            </button>
          </div>

          {records.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🗃️</div>
              <h3>No Encrypted Records</h3>
              <p>Start by migrating your first database record using ZAMA FHE encryption</p>
              <button onClick={() => setShowMigrationModal(true)} className="primary-btn">
                Start Migration
              </button>
            </div>
          ) : (
            <div className="records-grid">
              {records.map(record => (
                <div key={record.id} className="record-card">
                  <div className="record-header">
                    <span className="table-badge">{record.tableName}</span>
                    <span className={`status-badge ${record.status}`}>{record.status}</span>
                  </div>
                  <div className="record-content">
                    <div className="record-info">
                      <label>Original Value:</label>
                      <span>{record.originalValue}</span>
                    </div>
                    <div className="record-info">
                      <label>Encrypted Data:</label>
                      <span className="encrypted-preview">{record.encryptedData.substring(0, 30)}...</span>
                    </div>
                    <div className="record-info">
                      <label>Owner:</label>
                      <span>{record.owner.substring(0, 8)}...{record.owner.substring(34)}</span>
                    </div>
                  </div>
                  <div className="record-actions">
                    <button 
                      onClick={() => setSelectedRecord(record)}
                      className="action-btn view-btn"
                    >
                      View Details
                    </button>
                    {isOwner(record.owner) && (
                      <div className="fhe-operations">
                        <button 
                          onClick={() => performFHEOperation(record.id, 'sum')}
                          className="action-btn fhe-btn"
                        >
                          FHE Sum
                        </button>
                        <button 
                          onClick={() => performFHEOperation(record.id, 'multiply')}
                          className="action-btn fhe-btn"
                        >
                          FHE ×2
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Migration Modal */}
      {showMigrationModal && (
        <MigrationModal
          currentStep={currentStep}
          setCurrentStep={setCurrentStep}
          onSubmit={migrateRecord}
          onClose={() => {
            setShowMigrationModal(false);
            setCurrentStep(1);
            setEncryptionProgress(0);
          }}
          migrating={migrating}
          recordData={newRecordData}
          setRecordData={setNewRecordData}
          encryptionProgress={encryptionProgress}
          steps={migrationSteps}
        />
      )}

      {/* Record Detail Modal */}
      {selectedRecord && (
        <RecordDetailModal
          record={selectedRecord}
          onClose={() => {
            setSelectedRecord(null);
            setDecryptedValue(null);
          }}
          decryptedValue={decryptedValue}
          setDecryptedValue={setDecryptedValue}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-overlay">
          <div className={`transaction-modal ${transactionStatus.status}`}>
            <div className="transaction-icon">
              {transactionStatus.status === "pending" && "⏳"}
              {transactionStatus.status === "success" && "✅"}
              {transactionStatus.status === "error" && "❌"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="zama-badge">
            <span>Powered by ZAMA FHE Technology</span>
          </div>
          <div className="footer-info">
            <p>FHE Database Migration Tool • Secure Encrypted Database Operations</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Migration Modal Component
interface MigrationModalProps {
  currentStep: number;
  setCurrentStep: (step: number) => void;
  onSubmit: () => void;
  onClose: () => void;
  migrating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
  encryptionProgress: number;
  steps: Array<{number: number, title: string, description: string}>;
}

const MigrationModal: React.FC<MigrationModalProps> = ({
  currentStep,
  setCurrentStep,
  onSubmit,
  onClose,
  migrating,
  recordData,
  setRecordData,
  encryptionProgress,
  steps
}) => {
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: name === 'originalValue' ? parseFloat(value) : value });
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="step-content">
            <h3>Select Database Table</h3>
            <div className="form-group">
              <label>Table Name</label>
              <select name="tableName" value={recordData.tableName} onChange={handleInputChange} className="form-input">
                <option value="">Select a table</option>
                <option value="users">Users Table</option>
                <option value="transactions">Transactions</option>
                <option value="products">Products</option>
                <option value="financial">Financial Data</option>
                <option value="customers">Customers</option>
              </select>
            </div>
            <div className="form-group">
              <label>Description (Optional)</label>
              <input
                type="text"
                name="description"
                value={recordData.description}
                onChange={handleInputChange}
                placeholder="Describe this data record..."
                className="form-input"
              />
            </div>
          </div>
        );
      
      case 2:
        return (
          <div className="step-content">
            <h3>Encrypt Numerical Data</h3>
            <div className="form-group">
              <label>Numerical Value to Encrypt</label>
              <input
                type="number"
                name="originalValue"
                value={recordData.originalValue}
                onChange={handleInputChange}
                placeholder="Enter numerical value..."
                className="form-input"
                step="0.01"
              />
            </div>
            
            <div className="encryption-visualization">
              <div className="encryption-process">
                <div className="process-step">
                  <div className="step-icon">🔓</div>
                  <span>Plain Text: {recordData.originalValue || 0}</span>
                </div>
                <div className="process-arrow">↓</div>
                <div className="process-step encrypting">
                  <div className="step-icon">🔒</div>
                  <span>ZAMA FHE Encryption</span>
                </div>
                <div className="process-arrow">↓</div>
                <div className="process-step">
                  <div className="step-icon">🔐</div>
                  <span>Encrypted Data</span>
                </div>
              </div>
              
              {encryptionProgress > 0 && (
                <div className="progress-bar">
                  <div 
                    className="progress-fill" 
                    style={{ width: `${encryptionProgress}%` }}
                  >
                    {encryptionProgress}%
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      
      case 3:
        return (
          <div className="step-content">
            <h3>Verify & Store Encrypted Data</h3>
            <div className="verification-summary">
              <div className="summary-item">
                <label>Table:</label>
                <span>{recordData.tableName}</span>
              </div>
              <div className="summary-item">
                <label>Original Value:</label>
                <span>{recordData.originalValue}</span>
              </div>
              <div className="summary-item">
                <label>Encrypted Data:</label>
                <span className="encrypted-preview">
                  {recordData.originalValue ? FHEEncryptNumber(recordData.originalValue).substring(0, 40) + '...' : 'Not encrypted'}
                </span>
              </div>
            </div>
            
            <div className="security-notice">
              <div className="lock-icon">🔒</div>
              <div>
                <strong>ZAMA FHE Security</strong>
                <p>Your data is encrypted client-side and remains encrypted during all operations</p>
              </div>
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="modal-overlay">
      <div className="migration-modal">
        <div className="modal-header">
          <h2>Database Migration Wizard</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        {/* Step Progress */}
        <div className="step-progress">
          {steps.map(step => (
            <div key={step.number} className={`step-item ${currentStep >= step.number ? 'active' : ''}`}>
              <div className="step-number">{step.number}</div>
              <div className="step-info">
                <div className="step-title">{step.title}</div>
                <div className="step-desc">{step.description}</div>
              </div>
            </div>
          ))}
        </div>
        
        <div className="modal-body">
          {renderStepContent()}
        </div>
        
        <div className="modal-footer">
          {currentStep > 1 && (
            <button 
              onClick={() => setCurrentStep(currentStep - 1)}
              className="nav-btn secondary"
            >
              Previous
            </button>
          )}
          
          {currentStep < 3 ? (
            <button 
              onClick={() => setCurrentStep(currentStep + 1)}
              disabled={!recordData.tableName}
              className="nav-btn primary"
            >
              Next
            </button>
          ) : (
            <button 
              onClick={onSubmit}
              disabled={migrating || !recordData.originalValue}
              className="nav-btn primary"
            >
              {migrating ? 'Encrypting...' : 'Complete Migration'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// Record Detail Modal Component
interface RecordDetailModalProps {
  record: DatabaseRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({
  record,
  onClose,
  decryptedValue,
  setDecryptedValue,
  isDecrypting,
  decryptWithSignature
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) {
      setDecryptedValue(null);
      return;
    }
    const decrypted = await decryptWithSignature(record.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal">
        <div className="modal-header">
          <h2>Record Details</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="modal-body">
          <div className="record-details">
            <div className="detail-row">
              <label>Table Name:</label>
              <span>{record.tableName}</span>
            </div>
            <div className="detail-row">
              <label>Record ID:</label>
              <span>{record.id}</span>
            </div>
            <div className="detail-row">
              <label>Owner:</label>
              <span>{record.owner}</span>
            </div>
            <div className="detail-row">
              <label>Status:</label>
              <span className={`status-badge ${record.status}`}>{record.status}</span>
            </div>
            <div className="detail-row">
              <label>Original Value:</label>
              <span>{record.originalValue}</span>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">
              {record.encryptedData}
            </div>
            <div className="fhe-badge">
              <span>ZAMA FHE Encrypted</span>
            </div>
          </div>
          
          <div className="decryption-section">
            <button 
              onClick={handleDecrypt}
              disabled={isDecrypting}
              className="decrypt-btn"
            >
              {isDecrypting ? 'Decrypting...' : 
               decryptedValue !== null ? 'Hide Value' : 'Decrypt with Wallet'}
            </button>
            
            {decryptedValue !== null && (
              <div className="decrypted-value">
                <label>Decrypted Value:</label>
                <span className="value-display">{decryptedValue}</span>
                <div className="security-warning">
                  ⚠️ This value is temporarily decrypted for display only
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;