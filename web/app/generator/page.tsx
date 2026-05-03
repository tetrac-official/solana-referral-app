"use client";

import React, { useState, useEffect } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { Wallet } from "@coral-xyz/anchor";
import { USDC_MINT_MAINNET, USDC_MINT_DEVNET } from "@/lib/solana";
import { useNetwork } from "@/providers/NetworkProvider";
import {
  processPayment,
  processPaymentSol,
  initializeVault,
  vaultIsInitialized,
  getVaultBalance,
  formatUSDC,
  getSolscanUrl,
  translatePaymentError,
  registerAffiliate,
  getAffiliateConfig,
  AffiliateInfo,
} from "@/lib/program";
import Link from "next/link";

export default function URLGenerator() {
  const { isMainnet, setIsMainnet } = useNetwork();
  const { connection } = useConnection();
  const DEVNET_PROGRAM_ID = "DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3";
  const DEVNET_TEST_WALLET = "GgUWyS5rsH4Z3Cdk1sYWy3TiJgzN8jk6MdMW4BbkU7MU";

  const [programId, setProgramId] = useState(DEVNET_PROGRAM_ID);
  const [merchantId, setMerchantId] = useState(DEVNET_TEST_WALLET);
  const [affiliateId, setAffiliateId] = useState(DEVNET_TEST_WALLET);
  const [amount, setAmount] = useState("0.01");
  const [error, setError] = useState<string | null>(null);

  // Payment processing state
  const [isProcessing, setIsProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const [processSuccess, setProcessSuccess] = useState<string | null>(null);
  const [programBalance, setProgramBalance] = useState<number | null>(null);
  const [vaultReady, setVaultReady] = useState<boolean | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const [tokenType, setTokenType] = useState<"USDC" | "SOL">("SOL");

  // Affiliate state
  const [affiliateInfo, setAffiliateInfo] = useState<AffiliateInfo | null>(
    null,
  );
  const [affiliateLoading, setAffiliateLoading] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerSig, setRegisterSig] = useState<string | null>(null);

  const wallet = useWallet();

  // Get current USDC mint based on network
  const usdcMint = isMainnet ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;

  // Fetch global USDC vault balance + init status when program/network changes
  useEffect(() => {
    const fetchVaultState = async () => {
      if (!programId || tokenType === "SOL") {
        setProgramBalance(null);
        setVaultReady(tokenType === "SOL" ? true : null);
        return;
      }

      try {
        const programPubkey = new PublicKey(programId);
        const ready = await vaultIsInitialized(
          connection,
          programPubkey,
          usdcMint,
        );
        setVaultReady(ready);
        if (ready) {
          const balance = await getVaultBalance(
            connection,
            programPubkey,
            usdcMint,
          );
          setProgramBalance(balance);
        } else {
          setProgramBalance(null);
        }
      } catch (err) {
        console.error("Error fetching vault state:", err);
        setProgramBalance(null);
        setVaultReady(null);
      }
    };

    fetchVaultState();
  }, [programId, usdcMint, isMainnet, tokenType, connection]);

  // Auto-fill the affiliate field with the connected wallet's pubkey, but
  // only when the field still holds the initial test-wallet placeholder.
  // Syncing wallet → form state in an effect is the cleanest way to react
  // to a connect/disconnect — `affiliateId` is intentionally omitted from
  // deps because including it would re-trigger the sync as soon as the
  // user starts typing, defeating the "leave their value alone" intent.
  useEffect(() => {
    if (!wallet.connected || !wallet.publicKey) return;
    if (affiliateId === DEVNET_TEST_WALLET || affiliateId.trim() === "") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAffiliateId(wallet.publicKey.toBase58());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.connected, wallet.publicKey]);

  // Fetch affiliate registration status when affiliate ID changes
  useEffect(() => {
    const fetchAffiliateStatus = async () => {
      if (!affiliateId.trim() || !programId) {
        setAffiliateInfo(null);
        return;
      }
      try {
        setAffiliateLoading(true);
        const pubkey = new PublicKey(affiliateId);
        const programPubkey = new PublicKey(programId);
        const info = await getAffiliateConfig(
          connection,
          pubkey,
          programPubkey,
        );
        setAffiliateInfo(info);
      } catch {
        setAffiliateInfo(null);
      } finally {
        setAffiliateLoading(false);
      }
    };
    fetchAffiliateStatus();
  }, [affiliateId, programId, connection]);

  const handleRegisterAffiliate = async () => {
    if (!wallet.connected || !wallet.publicKey) {
      setProcessError("Connect your wallet to register as an affiliate");
      return;
    }
    if (!programId) {
      setProcessError("Enter a program ID first");
      return;
    }
    setIsRegistering(true);
    setProcessError(null);
    setRegisterSig(null);
    try {
      const sig = await registerAffiliate(
        connection,
        wallet as unknown as Wallet,
        new PublicKey(programId),
      );
      setRegisterSig(sig);
      // Make sure the affiliate field reflects the wallet that just registered
      setAffiliateId(wallet.publicKey.toBase58());
      // Refresh affiliate info for the connected wallet
      const info = await getAffiliateConfig(
        connection,
        wallet.publicKey,
        new PublicKey(programId),
      );
      setAffiliateInfo(info);
    } catch (err: unknown) {
      console.error("Register affiliate failed:", err);
      setProcessError(translatePaymentError(err));
    } finally {
      setIsRegistering(false);
    }
  };

  // Handle network toggle — updates the shared NetworkProvider which
  // re-creates the ConnectionProvider endpoint, so wallet + RPC stay in sync.
  const handleNetworkToggle = () => {
    const goingMainnet = !isMainnet;
    setIsMainnet(goingMainnet);
    setProcessError(null);
    setProcessSuccess(null);
    if (goingMainnet) {
      setProgramId("");
      setMerchantId("");
      setAffiliateId("");
      setAmount("");
    } else {
      setProgramId(DEVNET_PROGRAM_ID);
      setMerchantId(DEVNET_TEST_WALLET);
      setAffiliateId(DEVNET_TEST_WALLET);
      setAmount("0.01");
    }
  };

  const clearForm = () => {
    setProgramId("");
    setMerchantId("");
    setAffiliateId("");
    setAmount("");
    setError(null);
    setProcessError(null);
    setProcessSuccess(null);
  };

  const handleInitializeVault = async () => {
    if (!wallet.connected || !wallet.publicKey) {
      setProcessError("Please connect your wallet first");
      return;
    }
    if (!programId) {
      setProcessError("Enter a program ID first");
      return;
    }
    setProcessError(null);
    setProcessSuccess(null);
    setIsInitializing(true);
    try {
      const sig = await initializeVault(
        connection,
        wallet as unknown as Wallet,
        new PublicKey(programId),
        usdcMint,
      );
      setProcessSuccess(sig);
      setVaultReady(true);
    } catch (err: unknown) {
      console.error("Init vault failed:", err);
      setProcessError(translatePaymentError(err));
    } finally {
      setIsInitializing(false);
    }
  };

  const handleProcessPayment = async () => {
    if (!wallet.connected || !wallet.publicKey) {
      setProcessError("Please connect your wallet first");
      return;
    }
    setProcessError(null);
    setProcessSuccess(null);
    setIsProcessing(true);

    try {
      if (!programId || !merchantId) {
        throw new Error("Program ID and Merchant ID are required");
      }
      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) {
        throw new Error("Invalid amount");
      }

      const programPubkey = new PublicKey(programId);
      const merchantPubkey = new PublicKey(merchantId);
      const affiliatePubkey = affiliateId ? new PublicKey(affiliateId) : null;

      // Fresh per-payment reference (seeds the ReferenceStorage PDA — reusing one fails account init).
      const reference = Keypair.generate().publicKey;

      let signature: string;
      if (tokenType === "SOL") {
        signature = await processPaymentSol(
          connection,
          wallet as unknown as Wallet,
          programPubkey,
          merchantPubkey,
          affiliatePubkey,
          amountNum,
          reference,
        );
      } else {
        signature = await processPayment(
          connection,
          wallet as unknown as Wallet,
          programPubkey,
          merchantPubkey,
          affiliatePubkey,
          usdcMint,
          amountNum,
          reference,
        );
      }

      setProcessSuccess(signature);

      if (tokenType === "USDC") {
        const balance = await getVaultBalance(
          connection,
          programPubkey,
          usdcMint,
        );
        setProgramBalance(balance);
      }
    } catch (err: unknown) {
      console.error("Error processing payment:", err);
      setProcessError(translatePaymentError(err));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">
                Process Payment
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Pay a merchant with optional affiliate split — signed by your
                connected wallet.
              </p>
            </div>
            <div className="flex items-center gap-4">
              {/* Network Toggle */}
              <div className="flex items-center gap-3">
                <span
                  className={`text-sm font-medium ${!isMainnet ? "text-green-600" : "text-gray-500"}`}
                >
                  Devnet
                </span>
                <button
                  onClick={handleNetworkToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                    isMainnet ? "bg-[#3a479e]" : "bg-green-600"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      isMainnet ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
                <span
                  className={`text-sm font-medium ${isMainnet ? "text-[#3a479e]" : "text-gray-500"}`}
                >
                  Mainnet
                </span>
              </div>
              {/* Wallet Button */}
              <WalletMultiButton />
              <Link
                href="/"
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[#3a479e] hover:bg-[#2d3880] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#3a479e]"
              >
                Back to Dashboard
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Form */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            Payment Details
          </h2>

          <div className="space-y-6">
            {/* Token Type Selector */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Token
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setTokenType("SOL")}
                  className={`flex-1 px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                    tokenType === "SOL"
                      ? "bg-[#3a479e] text-white border-[#3a479e]"
                      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  SOL
                </button>
                <button
                  type="button"
                  onClick={() => setTokenType("USDC")}
                  className={`flex-1 px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                    tokenType === "USDC"
                      ? "bg-[#3a479e] text-white border-[#3a479e]"
                      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  USDC
                </button>
              </div>
            </div>

            {/* Program ID */}
            <div>
              <label
                htmlFor="programId"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Program ID (Smart Contract){" "}
                <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="programId"
                value={programId}
                onChange={(e) => setProgramId(e.target.value)}
                placeholder={
                  !isMainnet
                    ? `Default: ${DEVNET_PROGRAM_ID}`
                    : "Enter program ID"
                }
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3a479e] focus:border-transparent font-mono text-sm text-gray-900"
              />
              {!isMainnet && !programId && (
                <p className="mt-1 text-xs text-gray-500">
                  Default devnet program ID: {DEVNET_PROGRAM_ID}
                </p>
              )}
              {isMainnet && (
                <p className="mt-1 text-xs text-yellow-600">
                  Mainnet program ID not yet deployed. Enter manually when
                  available.
                </p>
              )}
            </div>

            {/* Merchant ID */}
            <div>
              <label
                htmlFor="merchantId"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Merchant Public Key <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="merchantId"
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value)}
                placeholder="Enter merchant's Solana public key"
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3a479e] focus:border-transparent font-mono text-sm text-gray-900"
              />
            </div>

            {/* Affiliate ID */}
            <div>
              <label
                htmlFor="affiliateId"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Affiliate Public Key{" "}
                <span className="text-gray-400">(Optional)</span>
              </label>
              <input
                type="text"
                id="affiliateId"
                value={affiliateId}
                onChange={(e) => setAffiliateId(e.target.value)}
                placeholder="Enter affiliate's Solana public key"
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3a479e] focus:border-transparent font-mono text-sm text-gray-900"
              />
              <p className="mt-1 text-xs text-gray-500">
                Affiliate must be registered on-chain. Commission is tiered:
                Starter 5%, Silver 10%, Gold 15%.
              </p>

              {/* Affiliate Status */}
              {affiliateId.trim() && (
                <div className="mt-2 p-3 rounded-lg border text-sm">
                  {affiliateLoading ? (
                    <p className="text-gray-500">
                      Checking affiliate status...
                    </p>
                  ) : affiliateInfo ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            affiliateInfo.tier === 0
                              ? "bg-gray-100 text-gray-800"
                              : affiliateInfo.tier === 1
                                ? "bg-gray-200 text-gray-800"
                                : "bg-yellow-100 text-yellow-800"
                          }`}
                        >
                          {affiliateInfo.tierName}
                        </span>
                        <span className="text-gray-700 font-medium">
                          {(affiliateInfo.commissionBps / 100).toFixed(1)}%
                          commission
                        </span>
                      </div>
                      <p className="text-gray-500 text-xs">
                        {affiliateInfo.totalReferrals} referrals &middot;
                        registered{" "}
                        {new Date(
                          affiliateInfo.createdAt * 1000,
                        ).toLocaleDateString()}
                      </p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-[#ea354b] font-medium">
                        Affiliate not registered
                      </p>
                      <p className="text-gray-500 text-xs mt-1">
                        This affiliate must register before they can earn
                        commissions.
                      </p>
                      {wallet.connected &&
                        wallet.publicKey?.toBase58() === affiliateId.trim() && (
                          <button
                            type="button"
                            onClick={handleRegisterAffiliate}
                            disabled={isRegistering}
                            className="mt-2 px-4 py-1.5 bg-[#3a479e] text-white rounded text-xs font-medium hover:bg-[#2d3880] disabled:opacity-50"
                          >
                            {isRegistering
                              ? "Registering..."
                              : "Register as Affiliate"}
                          </button>
                        )}
                      {registerSig && (
                        <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded">
                          <p className="text-xs font-semibold text-green-800 mb-1">
                            Registered! Tx signature:
                          </p>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 text-xs bg-green-100 text-green-900 px-2 py-1 rounded font-mono overflow-x-auto">
                              {registerSig}
                            </code>
                            <a
                              href={getSolscanUrl(registerSig, isMainnet)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 whitespace-nowrap"
                            >
                              View on Solscan
                            </a>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Amount */}
            <div>
              <label
                htmlFor="amount"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Amount ({tokenType}) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                id="amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Enter payment amount"
                step="0.01"
                min="0.01"
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3a479e] focus:border-transparent text-sm text-gray-900"
              />
            </div>

            {/* Error */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-md p-4">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            {/* Clear */}
            <div className="flex gap-4">
              <button
                type="button"
                onClick={clearForm}
                className="px-6 py-3 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 font-medium text-sm"
              >
                Clear Form
              </button>
            </div>
          </div>
        </div>

        {/* Process Payment (always visible, signs via connected wallet) */}
        <div className="bg-white rounded-lg shadow-sm p-6 mt-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            Process Payment
          </h2>

          {/* Payment Summary */}
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 mb-4">
            <h3 className="text-lg font-semibold text-indigo-900 mb-3">
              Payment Summary
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-indigo-700">Total Amount:</span>
                <span className="font-semibold text-indigo-900">
                  {amount && !isNaN(parseFloat(amount))
                    ? parseFloat(amount).toFixed(tokenType === "SOL" ? 4 : 2)
                    : "—"}{" "}
                  {tokenType}
                </span>
              </div>
              {affiliateId && affiliateInfo ? (
                (() => {
                  const pct = affiliateInfo.commissionBps / 10000;
                  const dec = tokenType === "SOL" ? 4 : 2;
                  const amt = parseFloat(amount);
                  const safe = !isNaN(amt);
                  return (
                    <>
                      <div className="flex justify-between">
                        <span className="text-indigo-700">
                          Affiliate ({(pct * 100).toFixed(1)}% —{" "}
                          {affiliateInfo.tierName}):
                        </span>
                        <span className="font-semibold text-indigo-900">
                          {safe ? (amt * pct).toFixed(dec) : "—"} {tokenType}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-indigo-700">
                          Merchant ({((1 - pct) * 100).toFixed(1)}%):
                        </span>
                        <span className="font-semibold text-indigo-900">
                          {safe ? (amt * (1 - pct)).toFixed(dec) : "—"}{" "}
                          {tokenType}
                        </span>
                      </div>
                    </>
                  );
                })()
              ) : affiliateId && !affiliateInfo ? (
                <div className="flex justify-between">
                  <span className="text-[#ea354b]">
                    Affiliate not registered — payment will fail
                  </span>
                </div>
              ) : (
                <div className="flex justify-between">
                  <span className="text-indigo-700">Merchant (100%):</span>
                  <span className="font-semibold text-indigo-900">
                    {amount && !isNaN(parseFloat(amount))
                      ? parseFloat(amount).toFixed(tokenType === "SOL" ? 4 : 2)
                      : "—"}{" "}
                    {tokenType}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Network Indicator */}
          <div className="mb-4">
            <div
              className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                isMainnet
                  ? "bg-indigo-100 text-indigo-800"
                  : "bg-green-100 text-green-800"
              }`}
            >
              {isMainnet ? "Mainnet" : "Devnet"}
            </div>
          </div>

          {/* Vault status (USDC only) */}
          {tokenType === "USDC" && (
            <div className="mb-4 p-4 bg-gray-50 rounded-lg">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-gray-700">
                  USDC Vault Balance:
                </span>
                <span className="text-lg font-bold text-indigo-900">
                  {vaultReady === false
                    ? "Not initialized"
                    : programBalance !== null
                      ? formatUSDC(programBalance) + " USDC"
                      : "Loading..."}
                </span>
              </div>
              {vaultReady === false && (
                <p className="mt-2 text-xs text-[#ea354b]">
                  The USDC vault for this program has not been initialized yet.
                  Anyone can initialize it by paying the rent.
                </p>
              )}
            </div>
          )}

          {/* Initialize USDC Vault */}
          {wallet.connected && tokenType === "USDC" && vaultReady === false && (
            <button
              onClick={handleInitializeVault}
              disabled={isInitializing}
              className="w-full mb-3 px-6 py-3 bg-[#3a479e] text-white rounded-md hover:bg-[#2d3880] font-medium text-sm disabled:bg-gray-300"
            >
              {isInitializing ? "Initializing..." : "Initialize USDC Vault"}
            </button>
          )}

          {/* Wallet network reminder */}
          {!isMainnet && wallet.connected && (
            <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-xs text-yellow-800">
                <strong>Devnet mode.</strong> Make sure your wallet
                (Phantom/Solflare) is also set to
                <strong> Devnet</strong> in its settings, otherwise the
                transaction will fail or target the wrong network.
              </p>
            </div>
          )}

          {/* Process Button */}
          {!wallet.connected ? (
            <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800">
                Connect your wallet to sign and process the payment.
              </p>
            </div>
          ) : (
            <button
              onClick={handleProcessPayment}
              disabled={isProcessing}
              className="w-full px-6 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium text-sm disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              {isProcessing ? "Processing..." : "Process Payment"}
            </button>
          )}

          {/* Success Message */}
          {processSuccess && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-sm font-semibold text-green-800 mb-2">
                Payment Processed Successfully!
              </p>
              <p className="text-xs text-green-700 mb-2">
                Transaction Signature:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-green-100 text-green-900 px-2 py-1 rounded font-mono overflow-x-auto">
                  {processSuccess}
                </code>
                <a
                  href={getSolscanUrl(processSuccess, isMainnet)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                >
                  View on Solscan
                </a>
              </div>
            </div>
          )}

          {/* Error Message */}
          {processError && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">{processError}</p>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <p className="text-center text-sm text-gray-500">
            Solana Pay Referral Dashboard - Decentralized Payment Tracking
          </p>
        </div>
      </footer>
    </div>
  );
}
