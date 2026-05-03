"use client";

import React, { useMemo } from "react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { NetworkProvider, useNetwork } from "../providers/NetworkProvider";

const wallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];

function SolanaProviders({ children }: { children: React.ReactNode }) {
  const { rpcUrl } = useNetwork();
  const endpoint = useMemo(() => rpcUrl, [rpcUrl]);

  return (
    <ConnectionProvider
      endpoint={endpoint}
      config={{ commitment: "confirmed" }}
    >
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export function WalletProviders({ children }: { children: React.ReactNode }) {
  return (
    <NetworkProvider>
      <SolanaProviders>{children}</SolanaProviders>
    </NetworkProvider>
  );
}
