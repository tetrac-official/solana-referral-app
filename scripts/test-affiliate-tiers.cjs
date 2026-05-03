#!/usr/bin/env node
/**
 * Test affiliate tier system on devnet (program).
 *
 * 1. Register an affiliate (self-registration at 5%)
 * 2. Do a SOL split — affiliate should get 5% not 20%
 * 3. Read affiliate stats after the split
 *
 * Usage: node scripts/test-affiliate-tiers.cjs
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
const fs = require("fs");

// --- Config ---
const PROGRAM_ID = new PublicKey("DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3");
const MERCHANT = new PublicKey("GgUWyS5rsH4Z3Cdk1sYWy3TiJgzN8jk6MdMW4BbkU7MU");
const CONNECTION = new Connection("https://api.devnet.solana.com", "confirmed");

// Load keypair
const keypairPath = path.join(require("os").homedir(), ".config", "solana", "id.json");
const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const PAYER = Keypair.fromSecretKey(Uint8Array.from(secret));

// The affiliate = the payer for this test
const AFFILIATE = PAYER.publicKey;
const AMOUNT_SOL = 0.01;

function deriveTokenAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_authority")],
    PROGRAM_ID
  );
}

function deriveAffiliateConfig(affiliateKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("affiliate"), affiliateKey.toBuffer()],
    PROGRAM_ID
  );
}

function deriveReferenceStorage(referenceKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reference"), referenceKey.toBuffer()],
    PROGRAM_ID
  );
}

/** Parse AffiliateConfig from raw account data (skip 8-byte discriminator). */
function parseAffiliateConfig(data) {
  let offset = 8; // skip discriminator
  const affiliate = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;
  const commissionBps = data.readUInt16LE(offset);
  offset += 2;
  const tier = data[offset];
  offset += 1;
  const totalReferrals = data.readUInt32LE(offset);
  offset += 4;
  const totalVolume = data.readBigUInt64LE(offset);
  offset += 8;
  const createdAt = Number(data.readBigInt64LE(offset));
  offset += 8;
  const updatedAt = Number(data.readBigInt64LE(offset));
  return {
    affiliate: affiliate.toBase58(),
    commissionBps,
    tier,
    tierName: ["Starter", "Silver", "Gold"][tier] || `Unknown(${tier})`,
    totalReferrals,
    totalVolume: Number(totalVolume),
    createdAt: new Date(createdAt * 1000).toISOString(),
    updatedAt: new Date(updatedAt * 1000).toISOString(),
  };
}

async function main() {
  const [affiliateConfig, affBump] = deriveAffiliateConfig(AFFILIATE);
  const [tokenAuthority, taBump] = deriveTokenAuthority();

  console.log(`Payer/Affiliate: ${PAYER.publicKey.toBase58()}`);
  console.log(`Merchant:        ${MERCHANT.toBase58()}`);
  console.log(`Program (v3):    ${PROGRAM_ID.toBase58()}`);
  console.log(`AffiliateConfig: ${affiliateConfig.toBase58()}`);
  console.log();

  // --- Step 1: Register affiliate ---
  const existingConfig = await CONNECTION.getAccountInfo(affiliateConfig);
  if (existingConfig) {
    console.log("Affiliate already registered. Skipping registration.");
    const parsed = parseAffiliateConfig(existingConfig.data);
    console.log("Current config:", parsed);
  } else {
    console.log("Registering affiliate...");
    const regDisc = Buffer.from([87, 121, 99, 184, 126, 63, 103, 217]);
    const regTx = new Transaction();
    regTx.add({
      keys: [
        { pubkey: PAYER.publicKey, isSigner: true, isWritable: true },
        { pubkey: affiliateConfig, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: regDisc,
    });
    const regSig = await sendAndConfirmTransaction(CONNECTION, regTx, [PAYER]);
    console.log(`Registered! Sig: ${regSig}`);
    console.log(`https://solscan.io/tx/${regSig}?cluster=devnet`);

    const newConfig = await CONNECTION.getAccountInfo(affiliateConfig);
    const parsed = parseAffiliateConfig(newConfig.data);
    console.log("New config:", parsed);
  }
  console.log();

  // --- Step 2: SOL split with tiered affiliate ---
  const amountLamports = Math.round(AMOUNT_SOL * 1e9);
  const referenceKp = Keypair.generate();
  const [referenceStorage] = deriveReferenceStorage(referenceKp.publicKey);

  const memoObj = { merchant_id: MERCHANT.toBase58(), affiliate_id: AFFILIATE.toBase58() };
  const memoData = JSON.stringify(memoObj);

  // Build receive_and_split_sol instruction data
  const disc = Buffer.from([160, 160, 191, 91, 83, 139, 185, 68]);
  const memoBytes = Buffer.from(memoData, "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(memoBytes.length);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(amountLamports));
  const ixData = Buffer.concat([disc, lenBuf, memoBytes, amountBuf]);

  // Pre-flight
  const merchantBalPre = await CONNECTION.getBalance(MERCHANT);
  const affiliateBalPre = await CONNECTION.getBalance(AFFILIATE);
  console.log(`Pre-flight merchant:  ${(merchantBalPre / 1e9).toFixed(6)} SOL`);
  console.log(`Pre-flight affiliate: ${(affiliateBalPre / 1e9).toFixed(6)} SOL`);

  const tx = new Transaction();

  // Transfer SOL payer → PDA
  tx.add(
    SystemProgram.transfer({
      fromPubkey: PAYER.publicKey,
      toPubkey: tokenAuthority,
      lamports: amountLamports,
    })
  );

  // receive_and_split_sol with affiliate + affiliate_config
  tx.add({
    keys: [
      { pubkey: PAYER.publicKey, isSigner: true, isWritable: true },
      { pubkey: tokenAuthority, isSigner: false, isWritable: true },
      { pubkey: MERCHANT, isSigner: false, isWritable: true },
      { pubkey: AFFILIATE, isSigner: false, isWritable: true },      // affiliate account
      { pubkey: affiliateConfig, isSigner: false, isWritable: true }, // affiliate_config PDA
      { pubkey: referenceKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: referenceStorage, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: ixData,
  });

  console.log(`\nSending SOL split (${AMOUNT_SOL} SOL)...`);
  try {
    const sig = await sendAndConfirmTransaction(CONNECTION, tx, [PAYER]);
    console.log(`SUCCESS! Sig: ${sig}`);
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
  const merchantBalPost = await CONNECTION.getBalance(MERCHANT);
  const affiliateBalPost = await CONNECTION.getBalance(AFFILIATE);
  const merchantDelta = (merchantBalPost - merchantBalPre) / 1e9;
  const affiliateDelta = (affiliateBalPost - affiliateBalPre) / 1e9;

  console.log(`\nPost-flight merchant:  ${(merchantBalPost / 1e9).toFixed(6)} SOL (delta: +${merchantDelta.toFixed(6)})`);
  console.log(`Post-flight affiliate: ${(affiliateBalPost / 1e9).toFixed(6)} SOL (delta: ${affiliateDelta.toFixed(6)})`);
  console.log(`\nExpected at 5%: merchant gets ${(AMOUNT_SOL * 0.95).toFixed(4)} SOL, affiliate gets ${(AMOUNT_SOL * 0.05).toFixed(4)} SOL`);

  // Read updated affiliate config
  const updatedConfig = await CONNECTION.getAccountInfo(affiliateConfig);
  const parsed = parseAffiliateConfig(updatedConfig.data);
  console.log("\nUpdated affiliate config:", parsed);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
