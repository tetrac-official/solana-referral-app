"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ConfirmedSignatureInfo,
  Connection,
  ParsedTransactionWithMeta,
  PublicKey,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import bs58 from "bs58";
import Link from "next/link";
import TransactionTable from "@/components/TransactionTable";
import {
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
  TransactionData,
  MemoData,
} from "@/lib/solana";
import { deriveTokenAuthority } from "@/lib/program";
import { useNetwork } from "@/providers/NetworkProvider";
import { getCachedState, getProgramId, saveCacheState } from "@/lib/storage";

// Public Solana RPC enforces per-method rate limits (~40 req / 10s for
// getParsedTransaction). Pacing requests at 3/s and retrying on 429 keeps
// us under the limit without needing a private RPC for local testing.
const RPC_PACE_MS = 300;
const RPC_MAX_RETRIES = 4;
// Cold-cache fetch ceiling. Smaller = fewer cold-start calls; larger =
// deeper history on first load. 25 takes ~8s sequentially.
const COLD_CACHE_LIMIT = 25;

// Anchor instruction discriminators (from web/idl/program.json). The memo
// is the first arg (Borsh `String`) on both payment instructions.
const RECEIVE_AND_SPLIT_DISC = new Uint8Array([
  106, 58, 83, 192, 186, 60, 192, 136,
]);
const RECEIVE_AND_SPLIT_SOL_DISC = new Uint8Array([
  160, 160, 191, 91, 83, 139, 185, 68,
]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Wraps getParsedTransaction with backoff on 429s. The public RPC returns
// "429" either as an HTTP status or embedded in the JSON-RPC error body —
// we match on the substring rather than parsing both shapes.
async function fetchParsedWithRetry(
  connection: Connection,
  signature: string,
): Promise<ParsedTransactionWithMeta | null> {
  for (let attempt = 0; attempt < RPC_MAX_RETRIES; attempt++) {
    try {
      return await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes("429");
      if (!isRateLimit || attempt === RPC_MAX_RETRIES - 1) throw err;
      // Exponential backoff: 1s, 2s, 4s. Lets the per-method window reset.
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  return null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// PublicKey() throws on anything that isn't valid 32-byte base58 — using
// that as the validity check keeps the rule the same as the on-chain one.
function isValidPubkey(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

// Decodes the memo from one of our program's payment instructions. Layout:
//   [8-byte discriminator][4-byte LE length][UTF-8 memo JSON][8-byte amount]
// Returns null when the instruction isn't ours, the discriminator doesn't
// match a payment call, or the memo isn't valid JSON. Note: payments emit
// NO Memo-program instruction — the memo is encoded inside the program's
// own instruction data, so this is the only way to recover it.
function extractAnchorMemo(
  ix: { programId: PublicKey; data?: string; parsed?: unknown },
  programId: PublicKey,
): MemoData | null {
  if (!ix.programId.equals(programId)) return null;
  // Parsed instructions expose `parsed`; Anchor calls aren't in the SPL
  // parser registry so they always come back unparsed with `data`.
  if (!ix.data) return null;

  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(ix.data);
  } catch {
    return null;
  }
  if (bytes.length < 12) return null;

  const disc = bytes.subarray(0, 8);
  const isPayment =
    bytesEqual(disc, RECEIVE_AND_SPLIT_DISC) ||
    bytesEqual(disc, RECEIVE_AND_SPLIT_SOL_DISC);
  if (!isPayment) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const memoLen = view.getUint32(8, true);
  if (bytes.length < 12 + memoLen) return null;

  const memoStr = new TextDecoder().decode(bytes.subarray(12, 12 + memoLen));
  let parsed: unknown;
  try {
    parsed = JSON.parse(memoStr);
  } catch {
    return null;
  }
  // Validate the runtime shape. JSON.parse can return anything — without
  // this check, a memo like `{ merchant_id: 0 }` would silently misattribute
  // amounts downstream because string comparisons (`owner === merchantStr`)
  // would all fail. Reject anything that isn't a real pubkey.
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!isValidPubkey(obj.merchant_id)) return null;
  if (obj.affiliate_id !== undefined && !isValidPubkey(obj.affiliate_id)) {
    return null;
  }
  return {
    merchant_id: obj.merchant_id,
    affiliate_id:
      typeof obj.affiliate_id === "string" ? obj.affiliate_id : undefined,
  };
}

// Parse a single fetched transaction into a TransactionData row, or return
// null if the tx isn't a memo'd payment we recognize. Pure function so the
// caller can map it across a batched getParsedTransactions response.
function parseTransactionRow(
  tx: ParsedTransactionWithMeta | null,
  sigInfo: ConfirmedSignatureInfo,
  vaultAtaStr: string,
  usdcMintStr: string,
  programPubkey: PublicKey,
): TransactionData | null {
  if (!tx || !tx.meta || !tx.transaction) return null;

  // Locate the program's payment instruction and recover the memo from
  // its data bytes. Walk top-level + inner instructions because a wallet
  // adapter (or future caller) may wrap the call in a CPI.
  let memoData: MemoData | null = null;
  for (const ix of tx.transaction.message.instructions) {
    memoData = extractAnchorMemo(ix, programPubkey);
    if (memoData) break;
  }
  if (!memoData) {
    for (const inner of tx.meta.innerInstructions ?? []) {
      for (const ix of inner.instructions) {
        memoData = extractAnchorMemo(ix, programPubkey);
        if (memoData) break;
      }
      if (memoData) break;
    }
  }
  if (!memoData) return null;

  const accountKeys = tx.transaction.message.accountKeys;
  const merchantStr = memoData.merchant_id;
  const affiliateStr = memoData.affiliate_id || null;

  // --- USDC path: per-account token-balance deltas, excluding the vault ATA. ---
  const postTokenBalances = tx.meta.postTokenBalances || [];
  const preTokenBalances = tx.meta.preTokenBalances || [];

  const preByIdx = new Map<number, number>();
  for (const b of preTokenBalances) {
    if (b.mint === usdcMintStr) {
      preByIdx.set(b.accountIndex, parseInt(b.uiTokenAmount.amount));
    }
  }

  const usdcDeltas = new Map<string, number>();
  for (const post of postTokenBalances) {
    if (post.mint !== usdcMintStr) continue;
    const acctKey = accountKeys[post.accountIndex];
    const acctStr =
      typeof acctKey === "string"
        ? acctKey
        : "pubkey" in acctKey
          ? acctKey.pubkey.toBase58()
          : String(acctKey);
    if (acctStr === vaultAtaStr) continue;
    const postAmt = parseInt(post.uiTokenAmount.amount);
    const preAmt = preByIdx.get(post.accountIndex) ?? 0;
    const delta = postAmt - preAmt;
    if (delta > 0) {
      const owner = post.owner || acctStr;
      usdcDeltas.set(owner, (usdcDeltas.get(owner) ?? 0) + delta);
    }
  }

  let usdcMerchantDelta = 0;
  let usdcAffiliateDelta = 0;
  for (const [owner, delta] of usdcDeltas) {
    if (owner === merchantStr) usdcMerchantDelta += delta;
    else if (affiliateStr && owner === affiliateStr)
      usdcAffiliateDelta += delta;
    // Fallback: if we can't identify the owner, attribute to merchant so
    // the row's totalAmount still reflects the payment.
    else usdcMerchantDelta += delta;
  }
  const usdcAmount = usdcMerchantDelta + usdcAffiliateDelta;

  // --- SOL path: only when no USDC moved. Per-account lamport deltas. ---
  let solMerchantDelta = 0;
  let solAffiliateDelta = 0;
  if (usdcAmount <= 0 && tx.meta.preBalances && tx.meta.postBalances) {
    for (let i = 0; i < accountKeys.length; i++) {
      const key = accountKeys[i];
      const keyStr =
        typeof key === "string"
          ? key
          : "pubkey" in key
            ? key.pubkey.toBase58()
            : String(key);
      const delta = tx.meta.postBalances[i] - tx.meta.preBalances[i];
      if (delta <= 0) continue;
      if (keyStr === merchantStr) solMerchantDelta += delta;
      else if (affiliateStr && keyStr === affiliateStr)
        solAffiliateDelta += delta;
    }
  }
  const solAmount = solMerchantDelta + solAffiliateDelta;

  const isUsdc = usdcAmount > 0;
  const transferAmount = isUsdc ? usdcAmount : solAmount;
  if (transferAmount <= 0) return null;

  return {
    signature: sigInfo.signature,
    timestamp: sigInfo.blockTime || Math.floor(Date.now() / 1000),
    totalAmount: transferAmount,
    merchantPubkey: merchantStr,
    affiliatePubkey: affiliateStr,
    affiliateAmount: isUsdc ? usdcAffiliateDelta : solAffiliateDelta,
    merchantAmount: isUsdc ? usdcMerchantDelta : solMerchantDelta,
    referenceKey: sigInfo.signature,
    tokenType: isUsdc ? "USDC" : "SOL",
  };
}

export default function Home() {
  const { isMainnet, setIsMainnet } = useNetwork();
  const { connection } = useConnection();

  const DEVNET_PROGRAM_ID =
    process.env.NEXT_PUBLIC_SOLFER_PROGRAM_ID_DEV ||
    "DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3";

  // Lazy-init from localStorage. Runs once during the initial render —
  // moves the load-and-validate step out of an effect (which would
  // otherwise need a synchronous setState and trigger
  // react-hooks/set-state-in-effect). Drops a bad cached value if present
  // so it doesn't keep loading on every refresh.
  const [programId, setProgramId] = useState<string>(() => {
    if (typeof window === "undefined") return ""; // SSR
    const saved = getProgramId();
    if (saved && isValidPubkey(saved)) return saved;
    if (saved) localStorage.removeItem("solana_pay_referral");
    return isMainnet ? "" : DEVNET_PROGRAM_ID;
  });
  const [transactions, setTransactions] = useState<TransactionData[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Prevents concurrent fetches from stacking up. React 18 strict mode
  // double-invokes effects in dev, and a slow cold-cache fetch can also
  // overlap with the 10s polling interval — both of those would pile RPC
  // calls and re-trigger 429s.
  const inFlightRef = useRef(false);

  const usdcMint = isMainnet ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;

  // useCallback gives this a stable identity so the polling effect can
  // depend on it without re-creating the interval every render. Re-creates
  // only when the network/RPC changes (which is what fetchTransactions
  // reads via closure).
  const fetchTransactions = useCallback(
    async (programPubkey: string, isPolling = false) => {
      // Skip if a fetch is already running. The next poll tick will pick up
      // any new sigs anyway.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        if (!isPolling) {
          setLoading(true);
        }
        setError(null);

        const programPublicKey = new PublicKey(programPubkey);

        // Derive the global vault ATA so we can exclude it from amount sums.
        // In the atomic split, USDC flows payer → vault → merchant(+affiliate),
        // leaving the vault with zero delta; summing positive deltas of the
        // non-vault token accounts recovers the total payment amount.
        const [tokenAuthority] = deriveTokenAuthority(programPublicKey);
        const vaultAta = await getAssociatedTokenAddress(
          usdcMint,
          tokenAuthority,
          true,
        );
        const vaultAtaStr = vaultAta.toBase58();
        const usdcMintStr = usdcMint.toBase58();

        // Pull cache for this program. If the cached programId differs (or
        // there's no cache), this returns null — we'll do a full fetch and
        // overwrite. This is also what scopes the cache to the current
        // network: switching networks changes the program ID, which misses.
        const cache = getCachedState(programPubkey);

        // On a fresh user action (not a poll), hydrate the table from cache
        // immediately so the UI isn't blank while the network fetch runs.
        if (!isPolling) {
          setTransactions(cache?.transactions ?? []);
        }

        // Only ask the RPC for signatures NEWER than the cursor we already
        // saw. On a warm cache this is usually zero or one new sig per poll
        // instead of COLD_CACHE_LIMIT, which is what was tripping the
        // public-RPC limiter.
        const sigs = await connection.getSignaturesForAddress(
          programPublicKey,
          {
            limit: COLD_CACHE_LIMIT,
            ...(cache?.lastSeenSignature
              ? { until: cache.lastSeenSignature }
              : {}),
          },
        );

        if (sigs.length === 0) {
          // Nothing new on chain. Still mark "Last updated" so the UI shows
          // the poll completed; persist the cache as-is to refresh its
          // timestamp.
          if (cache) {
            saveCacheState(
              programPubkey,
              cache.lastSeenSignature ?? "",
              cache.transactions,
            );
          } else {
            // Empty program (no signatures at all yet) — still record it so
            // future polls don't re-do a full scan.
            saveCacheState(programPubkey, "", []);
          }
          setLastUpdated(new Date());
          return;
        }

        // getSignaturesForAddress returns newest-first, so sigs[0] is the new
        // cursor. We track this regardless of whether the tx had a memo —
        // otherwise non-payment txs would be re-fetched forever.
        const newestSignature = sigs[0].signature;

        // Sequential, throttled fetches. Public RPC rate-limits per JSON-RPC
        // method (not per HTTP request), so batching via getParsedTransactions
        // doesn't help — pacing does. Each call is wrapped in retry-with-
        // backoff for transient 429s. Slow but reliable; warm-cache polls
        // typically only see 0–1 new sigs anyway.
        const newRows: TransactionData[] = [];
        for (let i = 0; i < sigs.length; i++) {
          try {
            const tx = await fetchParsedWithRetry(
              connection,
              sigs[i].signature,
            );
            const row = parseTransactionRow(
              tx,
              sigs[i],
              vaultAtaStr,
              usdcMintStr,
              programPublicKey,
            );
            if (row) newRows.push(row);
          } catch {
            // Drop this row; the next poll will retry from the same cursor
            // since we only advance lastSeenSignature on success below.
          }
          if (i < sigs.length - 1) await sleep(RPC_PACE_MS);
        }

        // Merge: new rows take precedence (in case a poll catches a tx that
        // was previously seen in some partial state), then dedupe-keep the
        // remaining cached rows.
        const existing = cache?.transactions ?? [];
        const newSigSet = new Set(newRows.map((r) => r.signature));
        const merged = [
          ...newRows,
          ...existing.filter((t) => !newSigSet.has(t.signature)),
        ];
        merged.sort((a, b) => b.timestamp - a.timestamp);

        saveCacheState(programPubkey, newestSignature, merged);
        setTransactions(merged);
        setLastUpdated(new Date());
      } catch (err) {
        console.error("Error fetching transactions:", err);
        setError(
          "Failed to fetch transactions. Please check the program ID and try again.",
        );
      } finally {
        setLoading(false);
        inFlightRef.current = false;
      }
    },
    [connection, usdcMint],
  );

  const handleNetworkToggle = () => {
    const newNetwork = !isMainnet;
    setIsMainnet(newNetwork);
    setTransactions([]);
    setLastUpdated(null);
    if (!newNetwork) {
      setProgramId(DEVNET_PROGRAM_ID);
      fetchTransactions(DEVNET_PROGRAM_ID);
    } else {
      // Mainnet program isn't deployed yet — leave the input empty.
      setProgramId("");
    }
  };

  // One-shot kickoff on first render. The initial programId already came
  // from localStorage / default via the useState initializer. The lint
  // rule disable below is intentional: fetchTransactions ultimately calls
  // setState, but it's async and gated by inFlightRef — the cascade the
  // rule warns about can't happen here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (programId) fetchTransactions(programId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll for updates every 10 seconds.
  useEffect(() => {
    if (!programId) return;
    const interval = setInterval(() => {
      fetchTransactions(programId, true);
    }, 10000);
    return () => clearInterval(interval);
  }, [programId, fetchTransactions]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!programId.trim()) return;

    try {
      // Validate public key format
      new PublicKey(programId);
      fetchTransactions(programId);
    } catch {
      setError(
        "Invalid Solana public key format. Please enter a valid public key.",
      );
    }
  };

  const handleClear = () => {
    setProgramId("");
    setTransactions([]);
    setError(null);
    setLastUpdated(null);
    localStorage.removeItem("solana_pay_referral");
  };

  // Drop any stale cache and re-pin to the deployed devnet program. Used
  // as the recovery path when localStorage holds a wrong/PDA address that
  // produces no payment rows — the regular "Clear" empties everything,
  // but most users want to land back on the working default.
  const handleResetToDefault = () => {
    localStorage.removeItem("solana_pay_referral");
    setTransactions([]);
    setError(null);
    setLastUpdated(null);
    setProgramId(DEVNET_PROGRAM_ID);
    fetchTransactions(DEVNET_PROGRAM_ID);
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">
                Solana Pay Referral Dashboard
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Track SOL & USDC payments with tiered affiliate splits (5% / 10%
                / 15%)
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
              <WalletMultiButton />
              <Link
                href="/generator"
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-[#3a479e] hover:bg-[#2d3880] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#3a479e]"
              >
                Create Payment URL
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Program ID Input */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-8">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="programId"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Program ID (Smart Contract)
              </label>
              <p className="text-xs text-gray-500 mb-2">
                The on-chain program address — not a wallet. Every payment that
                hits this program will appear below.
              </p>
              <div className="flex gap-2">
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
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#3a479e] focus:border-transparent font-mono text-sm text-gray-900"
                />
                <button
                  type="submit"
                  disabled={loading || !programId.trim()}
                  className="px-6 py-2 bg-[#3a479e] text-white rounded-md hover:bg-[#2d3880] disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
                >
                  Track Transactions
                </button>
                {!isMainnet && programId !== DEVNET_PROGRAM_ID && (
                  <button
                    type="button"
                    onClick={handleResetToDefault}
                    className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium text-sm whitespace-nowrap"
                    title="Drop the stored address and load the deployed devnet program ID"
                  >
                    Reset to default
                  </button>
                )}
                {programId.trim() !== "" && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className="px-6 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 font-medium text-sm"
                  >
                    Clear
                  </button>
                )}
              </div>
              {!isMainnet && !programId && (
                <p className="mt-2 text-xs text-gray-500">
                  Default devnet program ID: {DEVNET_PROGRAM_ID}
                </p>
              )}
              {isMainnet && (
                <p className="mt-2 text-xs text-yellow-600">
                  Mainnet program ID not yet deployed. Enter manually when
                  available.
                </p>
              )}
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-md p-4">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}
          </form>
        </div>

        {/* Transaction Table */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-gray-900">
              Transaction History
            </h2>
            {lastUpdated && (
              <p className="text-sm text-gray-500">
                Last updated: {lastUpdated.toLocaleTimeString()}
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                  Live
                </span>
              </p>
            )}
          </div>
          <TransactionTable
            transactions={transactions}
            loading={loading}
            isMainnet={isMainnet}
          />
        </div>

        {/* Info Box */}
        <div className="mt-8 bg-indigo-50 border border-indigo-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-indigo-900 mb-2">
            How it works
          </h3>
          <ul className="list-disc list-inside space-y-2 text-indigo-800 text-sm">
            <li>
              Use the toggle in the header to switch between Devnet (test) and
              Mainnet (production)
            </li>
            <li>
              The Program ID is the on-chain smart contract address (not a
              wallet) — every payment that invokes it appears below
            </li>
            <li>
              Each payment atomically splits SOL or USDC between the merchant
              and an optional affiliate, based on the affiliate&apos;s
              registered tier
            </li>
            <li>Devnet has a default program ID configured</li>
            <li>
              Transactions are fetched in real-time from the Solana blockchain
            </li>
            <li>
              Use the &ldquo;Create Payment URL&rdquo; button to send a payment
              with an optional affiliate split, signed by your connected wallet
            </li>
            <li>
              Transaction data is saved locally in your browser for offline
              viewing
            </li>
          </ul>
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
