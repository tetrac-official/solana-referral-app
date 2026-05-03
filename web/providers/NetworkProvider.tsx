"use client";

import React, { createContext, useContext, useState, useMemo } from "react";

interface NetworkContextValue {
  isMainnet: boolean;
  setIsMainnet: (v: boolean) => void;
  rpcUrl: string;
}

const NetworkContext = createContext<NetworkContextValue | undefined>(
  undefined,
);

export function useNetwork() {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useNetwork must be used within NetworkProvider");
  return ctx;
}

const MAINNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const DEVNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC || "https://api.devnet.solana.com";

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [isMainnet, setIsMainnet] = useState(false);

  const rpcUrl = useMemo(
    () => (isMainnet ? MAINNET_RPC : DEVNET_RPC),
    [isMainnet],
  );

  const value = useMemo(
    () => ({ isMainnet, setIsMainnet, rpcUrl }),
    [isMainnet, rpcUrl],
  );

  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  );
}
