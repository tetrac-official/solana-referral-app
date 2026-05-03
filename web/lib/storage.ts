import { TransactionData } from "./solana";

const STORAGE_KEY = "solana_pay_referral";

// Storage structure
interface StorageData {
  merchantId?: string;
  programId?: string;
  // Newest signature returned by getSignaturesForAddress at last fetch.
  // Used as the `until` cursor so subsequent polls only fetch new sigs,
  // regardless of whether they had a memo (filtering out non-payment txs
  // here would re-fetch them forever).
  lastSeenSignature?: string;
  transactions?: TransactionData[];
  lastUpdated?: number;
}

// Get all stored data
export const getStoredData = (): StorageData => {
  if (typeof window === "undefined") return {};

  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : {};
  } catch (error) {
    console.error("Error reading from localStorage:", error);
    return {};
  }
};

// Save data to localStorage
export const saveStoredData = (data: StorageData): void => {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.error("Error writing to localStorage:", error);
  }
};

// Get merchant ID
export const getMerchantId = (): string | undefined => {
  const data = getStoredData();
  return data.merchantId;
};

// Save merchant ID
export const saveMerchantId = (merchantId: string): void => {
  const data = getStoredData();
  data.merchantId = merchantId;
  saveStoredData(data);
};

// Get program ID
export const getProgramId = (): string | undefined => {
  const data = getStoredData();
  return data.programId;
};

// Save program ID
export const saveProgramId = (programId: string): void => {
  const data = getStoredData();
  data.programId = programId;
  saveStoredData(data);
};

// Get transactions for a merchant
export const getTransactions = (): TransactionData[] => {
  const data = getStoredData();
  return data.transactions || [];
};

// Save transactions
export const saveTransactions = (transactions: TransactionData[]): void => {
  const data = getStoredData();
  data.transactions = transactions;
  data.lastUpdated = Date.now();
  saveStoredData(data);
};

// Add a new transaction
export const addTransaction = (transaction: TransactionData): void => {
  const transactions = getTransactions();

  // Check if transaction already exists
  const exists = transactions.some(
    (t) => t.signature === transaction.signature,
  );
  if (exists) return;

  // Add new transaction
  transactions.unshift(transaction);
  saveTransactions(transactions);
};

// Read cached transactions + cursor for a specific program ID.
// Returns null when the cache belongs to a different program (forces a
// fresh fetch instead of leaking results across programs/networks).
export const getCachedState = (
  programId: string,
): { transactions: TransactionData[]; lastSeenSignature?: string } | null => {
  const data = getStoredData();
  if (data.programId !== programId) return null;
  return {
    transactions: data.transactions || [],
    lastSeenSignature: data.lastSeenSignature,
  };
};

// Persist the merged transaction list and the newest-signature cursor
// together, atomically. Always called after a successful fetch.
export const saveCacheState = (
  programId: string,
  lastSeenSignature: string,
  transactions: TransactionData[],
): void => {
  const data = getStoredData();
  data.programId = programId;
  data.lastSeenSignature = lastSeenSignature;
  data.transactions = transactions;
  data.lastUpdated = Date.now();
  saveStoredData(data);
};

// Clear all stored data
export const clearStoredData = (): void => {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error("Error clearing localStorage:", error);
  }
};
