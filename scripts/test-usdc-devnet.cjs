#!/usr/bin/env node
/**
 * Test USDC split payment on devnet.
 *
 * Steps:
 * 1. Initialize the USDC vault (if not already done)
 * 2. Transfer USDC from payer → vault
 * 3. Call receive_and_split to fan out 80/20 to merchant + affiliate
 *
 * Usage: node scripts/test-usdc-devnet.cjs
 */

const path = require("path");
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} = require(path.join(__dirname, "..", "web", "node_modules", "@solana", "web3.js"));
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} = require(path.join(__dirname, "..", "web", "node_modules", "@solana", "spl-token"));
const fs = require("fs");
const crypto = require("crypto");

// --- Config ---
const PROGRAM_ID = new PublicKey("DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC_DECIMALS = 6;
const MERCHANT = new PublicKey("GgUWyS5rsH4Z3Cdk1sYWy3TiJgzN8jk6MdMW4BbkU7MU");
const AFFILIATE = new PublicKey("GgUWyS5rsH4Z3Cdk1sYWy3TiJgzN8jk6MdMW4BbkU7MU");
const AMOUNT_USDC = 0.01; // 0.01 USDC
const CONNECTION = new Connection("https://api.devnet.solana.com", "confirmed");

// Load keypair
const keypairPath = path.join(require("os").homedir(), ".config", "solana", "id.json");
const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const PAYER = Keypair.fromSecretKey(Uint8Array.from(secret));

// --- Helpers ---
function deriveTokenAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_authority")],
    PROGRAM_ID
  );
}

function deriveReferenceStorage(referenceKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reference"), referenceKey.toBuffer()],
    PROGRAM_ID
  );
}

/** Build instruction data: 8-byte discriminator + borsh string + u64 */
function buildReceiveAndSplitData(memoData, amountRaw) {
  // discriminator for receive_and_split
  const disc = Buffer.from([106, 58, 83, 192, 186, 60, 192, 136]);
  const memoBytes = Buffer.from(memoData, "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(memoBytes.length);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(amountRaw));
  return Buffer.concat([disc, lenBuf, memoBytes, amountBuf]);
}

/** Build initialize instruction data */
function buildInitializeData() {
  return Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
}

async function main() {
  const amountRaw = Math.round(AMOUNT_USDC * 10 ** USDC_DECIMALS);
  const [tokenAuthority, bump] = deriveTokenAuthority();
  const vaultAta = await getAssociatedTokenAddress(USDC_MINT, tokenAuthority, true);
  const referenceKp = Keypair.generate();
  const [referenceStorage] = deriveReferenceStorage(referenceKp.publicKey);
  const merchantAta = await getAssociatedTokenAddress(USDC_MINT, MERCHANT);
  const payerAta = await getAssociatedTokenAddress(USDC_MINT, PAYER.publicKey);

  console.log(`Payer:       ${PAYER.publicKey.toBase58()}`);
  console.log(`Merchant:    ${MERCHANT.toBase58()}`);
  console.log(`Affiliate:   ${AFFILIATE.toBase58()}`);
  console.log(`Program:     ${PROGRAM_ID.toBase58()}`);
  console.log(`Amount:      ${AMOUNT_USDC} USDC (${amountRaw} raw)`);
  console.log(`Vault ATA:   ${vaultAta.toBase58()}`);
  console.log(`Reference:   ${referenceKp.publicKey.toBase58()}`);
  console.log(`RefStorage:  ${referenceStorage.toBase58()}`);
  console.log();

  // Check if vault exists
  const vaultInfo = await CONNECTION.getAccountInfo(vaultAta);
  if (!vaultInfo) {
    console.log("Vault not initialized. Initializing...");
    const initTx = new Transaction();
    const initData = buildInitializeData();
    initTx.add({
      keys: [
        { pubkey: PAYER.publicKey, isSigner: true, isWritable: true },
        { pubkey: tokenAuthority, isSigner: false, isWritable: false },
        { pubkey: USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: initData,
    });
    const initSig = await sendAndConfirmTransaction(CONNECTION, initTx, [PAYER]);
    console.log(`Vault initialized: ${initSig}`);
    console.log();
  } else {
    console.log("Vault already initialized.");
  }

  // Check payer USDC balance
  const payerAtaInfo = await CONNECTION.getAccountInfo(payerAta);
  if (!payerAtaInfo) {
    console.error("Payer has no USDC ATA. Get devnet USDC first.");
    process.exit(1);
  }

  // Pre-flight balances
  const payerUsdcPre = await CONNECTION.getTokenAccountBalance(payerAta);
  console.log(`Pre-flight payer USDC: ${payerUsdcPre.value.uiAmountString}`);

  // Check/create merchant ATA
  const merchantAtaInfo = await CONNECTION.getAccountInfo(merchantAta);

  const tx = new Transaction();

  if (!merchantAtaInfo) {
    console.log("Creating merchant USDC ATA...");
    tx.add(createAssociatedTokenAccountInstruction(PAYER.publicKey, merchantAta, MERCHANT, USDC_MINT));
  }

  // 1) Transfer USDC payer → vault
  tx.add(
    createTransferCheckedInstruction(
      payerAta,
      USDC_MINT,
      vaultAta,
      PAYER.publicKey,
      amountRaw,
      USDC_DECIMALS
    )
  );

  // 2) Call receive_and_split
  const memoObj = { merchant_id: MERCHANT.toBase58(), affiliate_id: AFFILIATE.toBase58() };
  const memoData = JSON.stringify(memoObj);
  const splitData = buildReceiveAndSplitData(memoData, amountRaw);

  // Affiliate ATA (same as merchant in this test)
  const affiliateAta = await getAssociatedTokenAddress(USDC_MINT, AFFILIATE);

  // v3: AffiliateConfig PDA (must exist on-chain — derived from affiliate pubkey)
  const [affiliateConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("affiliate"), AFFILIATE.toBuffer()],
    PROGRAM_ID,
  );

  tx.add({
    keys: [
      { pubkey: PAYER.publicKey, isSigner: true, isWritable: true },
      { pubkey: tokenAuthority, isSigner: false, isWritable: false },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: merchantAta, isSigner: false, isWritable: true },
      { pubkey: affiliateAta, isSigner: false, isWritable: true },
      { pubkey: affiliateConfig, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: referenceKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: referenceStorage, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: splitData,
  });

  console.log("\nSending transaction...");
  try {
    const sig = await sendAndConfirmTransaction(CONNECTION, tx, [PAYER]);
    console.log(`SUCCESS! Signature: ${sig}`);
    console.log(`https://solscan.io/tx/${sig}?cluster=devnet`);
  } catch (err) {
    console.error("Transaction failed:", err.message);
    if (err.logs) {
      console.error("\nProgram logs:");
      err.logs.forEach((l) => console.error("  ", l));
    }
    process.exit(1);
  }

  // Post-flight
  const payerUsdcPost = await CONNECTION.getTokenAccountBalance(payerAta);
  const merchantUsdcPost = await CONNECTION.getTokenAccountBalance(merchantAta);
  console.log(`\nPost-flight payer USDC:    ${payerUsdcPost.value.uiAmountString}`);
  console.log(`Post-flight merchant USDC: ${merchantUsdcPost.value.uiAmountString}`);

  const merchantDelta = parseFloat(merchantUsdcPost.value.uiAmountString) - 0; // first tx or cumulative
  console.log(`\nMerchant+Affiliate = same address, receives 100% of ${AMOUNT_USDC} USDC`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
