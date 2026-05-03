import {
  Program,
  AnchorProvider,
  BN,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import idl from "../idl/program.json";

const PROGRAM_ID = new PublicKey(idl.address);
const USDC_DECIMALS = 6;

export interface AffiliateInfo {
  affiliate: string;
  commissionBps: number;
  tier: number;
  tierName: string;
  totalReferrals: number;
  totalVolume: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentAccounts {
  tokenAuthority: PublicKey;
  programTokenAccount: PublicKey;
  merchantTokenAccount: PublicKey;
  affiliateTokenAccount: PublicKey | null;
  referenceStorage: PublicKey;
}

/** Derive the global token-authority PDA (seeds: ["token_authority"]). */
export function deriveTokenAuthority(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_authority")],
    programId,
  );
}

/** Derive reference storage PDA (seeds: ["reference", reference_key]). */
export function deriveReferenceStorage(
  referenceKey: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reference"), referenceKey.toBuffer()],
    programId,
  );
}

/** Derive affiliate config PDA (seeds: ["affiliate", affiliate_pubkey]). */
export function deriveAffiliateConfig(
  affiliatePubkey: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("affiliate"), affiliatePubkey.toBuffer()],
    programId,
  );
}

/** Resolve all accounts needed for the split payment. */
export async function derivePaymentAccounts(params: {
  programId: PublicKey;
  merchantPubkey: PublicKey;
  affiliatePubkey: PublicKey | null;
  usdcMint: PublicKey;
  referenceKey: PublicKey;
}): Promise<PaymentAccounts> {
  const [tokenAuthority] = deriveTokenAuthority(params.programId);

  const programTokenAccount = await getAssociatedTokenAddress(
    params.usdcMint,
    tokenAuthority,
    true, // PDA owner is off-curve
  );

  const merchantTokenAccount = await getAssociatedTokenAddress(
    params.usdcMint,
    params.merchantPubkey,
  );

  const affiliateTokenAccount = params.affiliatePubkey
    ? await getAssociatedTokenAddress(params.usdcMint, params.affiliatePubkey)
    : null;

  const [referenceStorage] = deriveReferenceStorage(
    params.referenceKey,
    params.programId,
  );

  return {
    tokenAuthority,
    programTokenAccount,
    merchantTokenAccount,
    affiliateTokenAccount,
    referenceStorage,
  };
}

/** True if the global vault ATA exists on-chain. */
export async function vaultIsInitialized(
  connection: Connection,
  programId: PublicKey,
  usdcMint: PublicKey,
): Promise<boolean> {
  const [tokenAuthority] = deriveTokenAuthority(programId);
  const vault = await getAssociatedTokenAddress(usdcMint, tokenAuthority, true);
  const info = await connection.getAccountInfo(vault);
  return info !== null;
}

/** One-time initialization of the global vault. */
export async function initializeVault(
  connection: Connection,
  wallet: Wallet,
  programId: PublicKey,
  usdcMint: PublicKey,
): Promise<string> {
  const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
    commitment: "confirmed",
  });
  const program = new Program(
    { ...idl, address: programId.toBase58() } as unknown as Idl,
    provider,
  );

  const [tokenAuthority] = deriveTokenAuthority(programId);
  const programTokenAccount = await getAssociatedTokenAddress(
    usdcMint,
    tokenAuthority,
    true,
  );

  return await program.methods
    .initialize()
    .accounts({
      payer: wallet.publicKey,
      tokenAuthority,
      usdcMint,
      programTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Self-register as an affiliate at Starter tier (5%). Affiliate pays rent. */
export async function registerAffiliate(
  connection: Connection,
  wallet: Wallet,
  programId: PublicKey,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");

  const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
    commitment: "confirmed",
  });
  const program = new Program(
    { ...idl, address: programId.toBase58() } as unknown as Idl,
    provider,
  );

  const [affiliateConfig] = deriveAffiliateConfig(wallet.publicKey, programId);

  return await program.methods
    .registerAffiliate()
    .accounts({
      affiliate: wallet.publicKey,
      affiliateConfig,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Read an affiliate's on-chain config. Returns null if not registered. */
export async function getAffiliateConfig(
  connection: Connection,
  affiliatePubkey: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): Promise<AffiliateInfo | null> {
  const [affiliateConfigPda] = deriveAffiliateConfig(
    affiliatePubkey,
    programId,
  );
  const info = await connection.getAccountInfo(affiliateConfigPda);
  if (!info) return null;

  const data = info.data;
  let offset = 8; // skip discriminator
  const affiliate = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  const commissionBps = data.readUInt16LE(offset);
  offset += 2;
  const tier = data[offset];
  offset += 1;
  const totalReferrals = data.readUInt32LE(offset);
  offset += 4;
  const totalVolume = Number(data.readBigUInt64LE(offset));
  offset += 8;
  const createdAt = Number(data.readBigInt64LE(offset));
  offset += 8;
  const updatedAt = Number(data.readBigInt64LE(offset));

  const tierNames = ["Starter", "Silver", "Gold"];
  return {
    affiliate: affiliate.toBase58(),
    commissionBps,
    tier,
    tierName: tierNames[tier] || `Tier ${tier}`,
    totalReferrals,
    totalVolume,
    createdAt,
    updatedAt,
  };
}

/**
 * Atomic payment: in a single transaction, transfer `amount` USDC from
 * payer → vault, then call receive_and_split which fans out 80/20 to
 * merchant and optional affiliate.
 *
 * amountUsdc is a decimal USDC value (e.g. 10.5 = 10.5 USDC).
 */
export async function processPayment(
  connection: Connection,
  wallet: Wallet,
  programId: PublicKey,
  merchantPubkey: PublicKey,
  affiliatePubkey: PublicKey | null,
  usdcMint: PublicKey,
  amountUsdc: number,
  referenceKey: PublicKey,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  if (amountUsdc <= 0) throw new Error("Amount must be > 0");

  const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
    commitment: "confirmed",
  });
  const program = new Program(
    { ...idl, address: programId.toBase58() } as unknown as Idl,
    provider,
  );

  const amountRaw = BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));

  const accounts = await derivePaymentAccounts({
    programId,
    merchantPubkey,
    affiliatePubkey,
    usdcMint,
    referenceKey,
  });

  const payerAta = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);

  const memoObj: { merchant_id: string; affiliate_id?: string } = {
    merchant_id: merchantPubkey.toBase58(),
  };
  if (affiliatePubkey) memoObj.affiliate_id = affiliatePubkey.toBase58();
  const memoData = JSON.stringify(memoObj);

  // Preflight: vault must exist
  const vaultInfo = await connection.getAccountInfo(
    accounts.programTokenAccount,
  );
  if (!vaultInfo) {
    throw new Error(
      "Program vault not initialized. Call initializeVault() first.",
    );
  }

  const tx = new Transaction();

  // Create merchant ATA if needed
  const merchantInfo = await connection.getAccountInfo(
    accounts.merchantTokenAccount,
  );
  if (!merchantInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        accounts.merchantTokenAccount,
        merchantPubkey,
        usdcMint,
      ),
    );
  }

  // Create affiliate ATA if needed
  if (accounts.affiliateTokenAccount && affiliatePubkey) {
    const affInfo = await connection.getAccountInfo(
      accounts.affiliateTokenAccount,
    );
    if (!affInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          accounts.affiliateTokenAccount,
          affiliatePubkey,
          usdcMint,
        ),
      );
    }
  }

  // 1) Transfer USDC payer → vault
  tx.add(
    createTransferCheckedInstruction(
      payerAta,
      usdcMint,
      accounts.programTokenAccount,
      wallet.publicKey,
      amountRaw,
      USDC_DECIMALS,
    ),
  );

  // Derive affiliate config PDA if affiliate is present
  const affiliateConfigPda = affiliatePubkey
    ? deriveAffiliateConfig(affiliatePubkey, programId)[0]
    : undefined;

  // 2) Program-invoked split
  const splitIx = await program.methods
    .receiveAndSplit(memoData, new BN(amountRaw.toString()))
    .accountsPartial({
      payer: wallet.publicKey,
      tokenAuthority: accounts.tokenAuthority,
      programTokenAccount: accounts.programTokenAccount,
      merchantTokenAccount: accounts.merchantTokenAccount,
      affiliateTokenAccount: accounts.affiliateTokenAccount ?? undefined,
      affiliateConfig: affiliateConfigPda,
      usdcMint,
      reference: referenceKey,
      referenceStorage: accounts.referenceStorage,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  tx.add(splitIx);

  return await provider.sendAndConfirm(tx);
}

const SOL_DECIMALS = 9;

/**
 * Atomic SOL payment: transfer SOL from payer → PDA, then split to
 * merchant (80%) and optional affiliate (20%).
 *
 * amountSol is a decimal SOL value (e.g. 0.05 = 0.05 SOL).
 */
export async function processPaymentSol(
  connection: Connection,
  wallet: Wallet,
  programId: PublicKey,
  merchantPubkey: PublicKey,
  affiliatePubkey: PublicKey | null,
  amountSol: number,
  referenceKey: PublicKey,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  if (amountSol <= 0) throw new Error("Amount must be > 0");

  const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
    commitment: "confirmed",
  });
  const program = new Program(
    { ...idl, address: programId.toBase58() } as unknown as Idl,
    provider,
  );

  const amountLamports = BigInt(Math.round(amountSol * 10 ** SOL_DECIMALS));

  const [tokenAuthority] = deriveTokenAuthority(programId);
  const [referenceStorage] = deriveReferenceStorage(referenceKey, programId);

  const memoObj: { merchant_id: string; affiliate_id?: string } = {
    merchant_id: merchantPubkey.toBase58(),
  };
  if (affiliatePubkey) memoObj.affiliate_id = affiliatePubkey.toBase58();
  const memoData = JSON.stringify(memoObj);

  const tx = new Transaction();

  // 1) Transfer SOL payer → PDA
  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tokenAuthority,
      lamports: amountLamports,
    }),
  );

  // Derive affiliate config PDA if affiliate is present
  const affiliateConfigPda = affiliatePubkey
    ? deriveAffiliateConfig(affiliatePubkey, programId)[0]
    : undefined;

  // 2) Program-invoked SOL split
  const splitIx = await program.methods
    .receiveAndSplitSol(memoData, new BN(amountLamports.toString()))
    .accountsPartial({
      payer: wallet.publicKey,
      tokenAuthority,
      merchant: merchantPubkey,
      affiliate: affiliatePubkey ?? undefined,
      affiliateConfig: affiliateConfigPda,
      reference: referenceKey,
      referenceStorage,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  tx.add(splitIx);

  return await provider.sendAndConfirm(tx);
}

/**
 * Admin-only: sweep all USDC from the vault to a destination ATA.
 */
export async function sweepVault(
  connection: Connection,
  wallet: Wallet,
  programId: PublicKey,
  usdcMint: PublicKey,
  destinationAta: PublicKey,
): Promise<string> {
  const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
    commitment: "confirmed",
  });
  const program = new Program(
    { ...idl, address: programId.toBase58() } as unknown as Idl,
    provider,
  );

  const [tokenAuthority] = deriveTokenAuthority(programId);
  const programTokenAccount = await getAssociatedTokenAddress(
    usdcMint,
    tokenAuthority,
    true,
  );

  return await program.methods
    .sweep()
    .accounts({
      admin: wallet.publicKey,
      tokenAuthority,
      programTokenAccount,
      destination: destinationAta,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
}

/**
 * Admin-only: sweep excess SOL from the PDA to a destination wallet.
 */
export async function sweepSol(
  connection: Connection,
  wallet: Wallet,
  programId: PublicKey,
  destination: PublicKey,
): Promise<string> {
  const provider = new AnchorProvider(connection, wallet as unknown as Wallet, {
    commitment: "confirmed",
  });
  const program = new Program(
    { ...idl, address: programId.toBase58() } as unknown as Idl,
    provider,
  );

  const [tokenAuthority] = deriveTokenAuthority(programId);

  return await program.methods
    .sweepSol()
    .accounts({
      admin: wallet.publicKey,
      tokenAuthority,
      destination,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Read the global vault USDC balance (raw units, 6 decimals). */
export async function getVaultBalance(
  connection: Connection,
  programId: PublicKey,
  usdcMint: PublicKey,
): Promise<number | null> {
  const [tokenAuthority] = deriveTokenAuthority(programId);
  const vault = await getAssociatedTokenAddress(usdcMint, tokenAuthority, true);
  const info = await connection.getAccountInfo(vault);
  if (!info) return null;
  const amountBytes = info.data.slice(64, 72);
  const amount = new DataView(
    amountBytes.buffer,
    amountBytes.byteOffset,
    amountBytes.byteLength,
  ).getBigUint64(0, true);
  return Number(amount);
}

export async function tokenAccountExists(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(tokenAccount);
  return info !== null;
}

export function getSolscanUrl(signature: string, isMainnet = false): string {
  return `https://solscan.io/tx/${signature}${isMainnet ? "" : "?cluster=devnet"}`;
}

export function getAccountSolscanUrl(
  pubkey: string,
  isMainnet = false,
): string {
  return `https://solscan.io/account/${pubkey}${isMainnet ? "" : "?cluster=devnet"}`;
}

export function formatUSDC(amountRaw: number): string {
  return (amountRaw / 10 ** USDC_DECIMALS).toFixed(2);
}

export function parseUSDC(amount: string | number): number {
  return Math.floor(parseFloat(String(amount)) * 10 ** USDC_DECIMALS);
}

/**
 * Map thrown errors from initializeVault / processPayment into a message
 * that's useful to show a user. Handles AnchorError (program errors),
 * SendTransactionError (with logs), and plain JS errors.
 */
const ANCHOR_ERROR_COPY: Record<string, string> = {
  ArithmeticOverflow: "Amount caused an arithmetic overflow.",
  InvalidMemoFormat: "The memo is not valid JSON or is missing braces.",
  MissingMerchantId: "Memo is missing the merchant_id field.",
  InvalidMerchantPubkey: "Memo's merchant_id is not a valid Solana pubkey.",
  InvalidAffiliatePubkey: "Memo's affiliate_id is not a valid Solana pubkey.",
  MerchantMismatch:
    "Merchant token account owner doesn't match the memo's merchant_id.",
  AffiliateMismatch:
    "Affiliate account is missing or doesn't match the memo's affiliate_id.",
  InvalidAmount: "Amount must be greater than zero.",
  AmountBelowMinimum:
    "Amount is below the minimum threshold (1000 lamports for SOL, 0.001 USDC).",
  Unauthorized: "Only the program admin can perform this action.",
  CommissionTooHigh: "Commission cannot exceed 20% (2000 bps).",
};

export function translatePaymentError(err: unknown): string {
  if (!err) return "Unknown error";

  const anyErr = err as {
    error?: { errorCode?: { code?: string }; errorMessage?: string };
    message?: string;
    logs?: string[];
  };

  const code = anyErr.error?.errorCode?.code;
  if (code && ANCHOR_ERROR_COPY[code]) return ANCHOR_ERROR_COPY[code];
  if (anyErr.error?.errorMessage) return anyErr.error.errorMessage;

  const logs: string[] | undefined =
    anyErr.logs ?? (anyErr as { transactionLogs?: string[] }).transactionLogs;
  if (logs) {
    for (const line of logs) {
      const m = line.match(/Error Code: (\w+)/);
      if (m && ANCHOR_ERROR_COPY[m[1]]) return ANCHOR_ERROR_COPY[m[1]];
    }
    const joined = logs.join("\n");
    if (/insufficient funds/i.test(joined))
      return "Insufficient USDC balance in your wallet to complete the transfer.";
    if (/custom program error: 0x1/.test(joined))
      return "Token program reported a transfer error (often insufficient funds or uninitialized ATA).";
  }

  const msg = anyErr.message || String(err);
  if (/User rejected/i.test(msg))
    return "Transaction was rejected in the wallet.";
  if (/blockhash/i.test(msg))
    return "Transaction expired before confirmation. Try again.";
  return msg;
}
