#!/usr/bin/env node
/**
 * Admin script: promote an affiliate's tier and commission rate.
 *
 * Usage:
 *   node scripts/promote-affiliate.cjs <affiliate_pubkey> <tier> <bps>
 *
 * Examples:
 *   node scripts/promote-affiliate.cjs GgUWy...MrF 1 1000   # Silver, 10%
 *   node scripts/promote-affiliate.cjs GgUWy...MrF 2 1500   # Gold, 15%
 *
 * Tiers: 0=Starter(5%), 1=Silver(10%), 2=Gold(15%)
 * Max BPS: 2000 (20%)
 */

const path = require("path");
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require(path.join(__dirname, "..", "web", "node_modules", "@solana", "web3.js"));
const fs = require("fs");

const PROGRAM_ID = new PublicKey("DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3");
const CONNECTION = new Connection("https://api.devnet.solana.com", "confirmed");

const keypairPath = path.join(require("os").homedir(), ".config", "solana", "id.json");
const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const ADMIN = Keypair.fromSecretKey(Uint8Array.from(secret));

function deriveAffiliateConfig(affiliateKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("affiliate"), affiliateKey.toBuffer()],
    PROGRAM_ID
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error("Usage: node scripts/promote-affiliate.cjs <affiliate_pubkey> <tier> <bps>");
    console.error("  tier: 0=Starter, 1=Silver, 2=Gold");
    console.error("  bps:  500=5%, 1000=10%, 1500=15%, 2000=20%");
    process.exit(1);
  }

  const affiliatePubkey = new PublicKey(args[0]);
  const newTier = parseInt(args[1]);
  const newBps = parseInt(args[2]);

  if (newBps > 2000) {
    console.error("Error: bps cannot exceed 2000 (20%)");
    process.exit(1);
  }

  const [affiliateConfig] = deriveAffiliateConfig(affiliatePubkey);

  // Check affiliate exists
  const configInfo = await CONNECTION.getAccountInfo(affiliateConfig);
  if (!configInfo) {
    console.error(`Error: Affiliate ${affiliatePubkey.toBase58()} is not registered.`);
    process.exit(1);
  }

  console.log(`Admin:           ${ADMIN.publicKey.toBase58()}`);
  console.log(`Affiliate:       ${affiliatePubkey.toBase58()}`);
  console.log(`AffiliateConfig: ${affiliateConfig.toBase58()}`);
  console.log(`New tier:        ${newTier} (${["Starter", "Silver", "Gold"][newTier] || "Unknown"})`);
  console.log(`New commission:  ${newBps} bps (${(newBps / 100).toFixed(1)}%)`);
  console.log();

  // Build promote_affiliate instruction
  const disc = Buffer.from([10, 129, 21, 38, 107, 251, 2, 188]);
  const tierBuf = Buffer.alloc(1);
  tierBuf.writeUInt8(newTier);
  const bpsBuf = Buffer.alloc(2);
  bpsBuf.writeUInt16LE(newBps);
  const ixData = Buffer.concat([disc, tierBuf, bpsBuf]);

  const tx = new Transaction();
  tx.add({
    keys: [
      { pubkey: ADMIN.publicKey, isSigner: true, isWritable: true },
      { pubkey: affiliateConfig, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data: ixData,
  });

  const sig = await sendAndConfirmTransaction(CONNECTION, tx, [ADMIN]);
  console.log(`Promoted! Sig: ${sig}`);
  console.log(`https://solscan.io/tx/${sig}?cluster=devnet`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.logs) err.logs.forEach((l) => console.error("  ", l));
  process.exit(1);
});
