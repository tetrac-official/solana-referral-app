import { Connection, PublicKey } from "@solana/web3.js";

// Solana RPC endpoints
export const MAINNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.mainnet-beta.solana.com";
export const DEVNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC || "https://api.devnet.solana.com";

// USDC mint addresses
export const USDC_MINT_MAINNET = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT_MAIN ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
export const USDC_MINT_DEVNET = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT_DEV ||
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

// Create connection to Solana
export const createConnection = (isMainnet: boolean = true) => {
  const rpcUrl = isMainnet ? MAINNET_RPC : DEVNET_RPC;
  const wsUrl = isMainnet
    ? process.env.NEXT_PUBLIC_SOLANA_WS || "wss://api.mainnet-beta.solana.com"
    : process.env.NEXT_PUBLIC_SOLANA_DEVNET_WS || "wss://api.devnet.solana.com";

  return new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: wsUrl,
  });
};

// Interface for transaction data
export interface TransactionData {
  signature: string;
  timestamp: number;
  totalAmount: number;
  merchantPubkey: string;
  affiliatePubkey: string | null;
  affiliateAmount: number;
  merchantAmount: number;
  referenceKey: string;
  tokenType: "SOL" | "USDC";
}

// Interface for memo data
export interface MemoData {
  merchant_id: string;
  affiliate_id?: string;
}

// Parse memo from transaction
export const parseMemo = (memoBase64: string): MemoData | null => {
  try {
    const memoString = Buffer.from(memoBase64, "base64").toString("utf-8");
    return JSON.parse(memoString);
  } catch (error) {
    console.error("Error parsing memo:", error);
    return null;
  }
};

// Format USDC amount (6 decimals)
export const formatUSDC = (amount: number): string => {
  return (amount / 1_000_000).toFixed(2);
};

// Format SOL amount (9 decimals)
export const formatSOL = (amount: number): string => {
  return (amount / 1_000_000_000).toFixed(4);
};

// Parse USDC amount to smallest units
export const parseUSDC = (amount: string): number => {
  return Math.floor(parseFloat(amount) * 1_000_000);
};

// Get Solscan URL for transaction
export const getSolscanUrl = (signature: string, isMainnet = false): string => {
  return `https://solscan.io/tx/${signature}${isMainnet ? "" : "?cluster=devnet"}`;
};

// Get Solscan URL for account
export const getAccountSolscanUrl = (
  pubkey: string,
  isMainnet = false,
): string => {
  return `https://solscan.io/account/${pubkey}${isMainnet ? "" : "?cluster=devnet"}`;
};

// Format timestamp to readable date
export const formatTimestamp = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleString();
};
