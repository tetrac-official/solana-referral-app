"use client";

import React from "react";
import {
  TransactionData,
  formatUSDC,
  formatSOL,
  formatTimestamp,
  getSolscanUrl,
  getAccountSolscanUrl,
} from "@/lib/solana";

interface TransactionTableProps {
  transactions: TransactionData[];
  loading?: boolean;
  isMainnet?: boolean;
}

function formatAmount(
  amount: number,
  tokenType: "SOL" | "USDC" = "USDC",
): string {
  return tokenType === "SOL" ? formatSOL(amount) : formatUSDC(amount);
}

export default function TransactionTable({
  transactions,
  loading,
  isMainnet = false,
}: TransactionTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#3a479e]"></div>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="text-center py-12 px-4">
        <div className="text-gray-400 text-6xl mb-4">📊</div>
        <h3 className="text-xl font-semibold text-gray-700 mb-2">
          No Transactions Found
        </h3>
        <p className="text-gray-500">
          Either the program ID has no payments yet, or the address above
          isn&apos;t the deployed program. Use{" "}
          <span className="font-mono">Reset to default</span> to load the devnet
          program ID.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full bg-white border border-gray-200 rounded-lg shadow-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Timestamp
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Transaction
            </th>
            <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
              Token
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Total
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Affiliate
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Affiliate Amount
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
              Merchant Amount
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Reference
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {transactions.map((tx) => (
            <tr
              key={tx.signature}
              className="hover:bg-gray-50 transition-colors"
            >
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                {formatTimestamp(tx.timestamp)}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm">
                <a
                  href={getSolscanUrl(tx.signature, isMainnet)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#3a479e] hover:text-[#2d3880] font-mono text-xs"
                >
                  {tx.signature.slice(0, 8)}...{tx.signature.slice(-8)}
                </a>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-center">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    tx.tokenType === "SOL"
                      ? "bg-indigo-100 text-indigo-800"
                      : "bg-green-100 text-green-800"
                  }`}
                >
                  {tx.tokenType || "USDC"}
                </span>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right font-semibold text-gray-900">
                {formatAmount(tx.totalAmount, tx.tokenType)}{" "}
                {tx.tokenType || "USDC"}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm">
                {tx.affiliatePubkey ? (
                  <a
                    href={getAccountSolscanUrl(tx.affiliatePubkey, isMainnet)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#12bff8] hover:text-[#0ea5d6] font-mono text-xs"
                  >
                    {tx.affiliatePubkey.slice(0, 8)}...
                    {tx.affiliatePubkey.slice(-8)}
                  </a>
                ) : (
                  <span className="text-gray-400">None</span>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-[#12bff8]">
                {formatAmount(tx.affiliateAmount, tx.tokenType)}{" "}
                {tx.tokenType || "USDC"}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-[#22c55e]">
                {formatAmount(tx.merchantAmount, tx.tokenType)}{" "}
                {tx.tokenType || "USDC"}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-700">
                {tx.referenceKey.slice(0, 8)}...{tx.referenceKey.slice(-8)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Summary Stats */}
      {(() => {
        const solTxs = transactions.filter((tx) => tx.tokenType === "SOL");
        const usdcTxs = transactions.filter((tx) => tx.tokenType === "USDC");
        const solVolume = solTxs.reduce((s, tx) => s + tx.totalAmount, 0);
        const usdcVolume = usdcTxs.reduce((s, tx) => s + tx.totalAmount, 0);
        const solFees = solTxs.reduce((s, tx) => s + tx.affiliateAmount, 0);
        const usdcFees = usdcTxs.reduce((s, tx) => s + tx.affiliateAmount, 0);
        return (
          <div className="mt-4 p-4 bg-gray-50 rounded-lg">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-gray-500">Total Transactions</p>
                <p className="text-2xl font-bold text-gray-900">
                  {transactions.length}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Volume</p>
                {solVolume > 0 && (
                  <p className="text-2xl font-bold text-[#3a479e]">
                    {formatSOL(solVolume)} SOL
                  </p>
                )}
                {usdcVolume > 0 && (
                  <p className="text-2xl font-bold text-[#3a479e]">
                    {formatUSDC(usdcVolume)} USDC
                  </p>
                )}
                {solVolume === 0 && usdcVolume === 0 && (
                  <p className="text-2xl font-bold text-[#3a479e]">0</p>
                )}
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Affiliate Fees</p>
                {solFees > 0 && (
                  <p className="text-2xl font-bold text-[#12bff8]">
                    {formatSOL(solFees)} SOL
                  </p>
                )}
                {usdcFees > 0 && (
                  <p className="text-2xl font-bold text-[#12bff8]">
                    {formatUSDC(usdcFees)} USDC
                  </p>
                )}
                {solFees === 0 && usdcFees === 0 && (
                  <p className="text-2xl font-bold text-[#12bff8]">0</p>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
