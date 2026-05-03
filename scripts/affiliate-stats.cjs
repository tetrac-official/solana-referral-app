#!/usr/bin/env node
/**
 * Query an affiliate's on-chain stats (commission, tier, referrals, volume).
 *
 * Usage:
 *   node scripts/affiliate-stats.cjs <affiliate_pubkey>
 *   node scripts/affiliate-stats.cjs --all               # list all registered affiliates
 */

const path = require("path");
const {
  Connection,
  PublicKey,
} = require(path.join(__dirname, "..", "web", "node_modules", "@solana", "web3.js"));

const PROGRAM_ID = new PublicKey("DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3");
const CONNECTION = new Connection("https://api.devnet.solana.com", "confirmed");
const AFFILIATE_CONFIG_DISC = Buffer.from([59, 190, 66, 88, 43, 52, 139, 29]);

function deriveAffiliateConfig(affiliateKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("affiliate"), affiliateKey.toBuffer()],
    PROGRAM_ID
  );
}

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
    commissionPct: `${(commissionBps / 100).toFixed(1)}%`,
    tier,
    tierName: ["Starter", "Silver", "Gold"][tier] || `Unknown(${tier})`,
    totalReferrals,
    totalVolume: Number(totalVolume),
    createdAt: new Date(createdAt * 1000).toISOString(),
    updatedAt: new Date(updatedAt * 1000).toISOString(),
  };
}

async function queryOne(pubkeyStr) {
  const affiliateKey = new PublicKey(pubkeyStr);
  const [affiliateConfig] = deriveAffiliateConfig(affiliateKey);

  const info = await CONNECTION.getAccountInfo(affiliateConfig);
  if (!info) {
    console.log(`Affiliate ${pubkeyStr} is NOT registered.`);
    return;
  }

  const config = parseAffiliateConfig(info.data);
  console.log(`Affiliate: ${config.affiliate}`);
  console.log(`Tier:      ${config.tierName} (${config.tier})`);
  console.log(`Commission: ${config.commissionPct} (${config.commissionBps} bps)`);
  console.log(`Referrals: ${config.totalReferrals}`);
  console.log(`Volume:    ${config.totalVolume} (raw units)`);
  console.log(`Registered: ${config.createdAt}`);
  console.log(`Updated:    ${config.updatedAt}`);
}

async function queryAll() {
  console.log("Fetching all AffiliateConfig accounts...\n");

  const accounts = await CONNECTION.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: AFFILIATE_CONFIG_DISC.toString("base64"), encoding: "base64" } },
    ],
  });

  if (accounts.length === 0) {
    console.log("No registered affiliates found.");
    return;
  }

  console.log(`Found ${accounts.length} affiliate(s):\n`);
  console.log(
    "Affiliate".padEnd(46) +
    "Tier".padEnd(10) +
    "BPS".padEnd(6) +
    "Referrals".padEnd(12) +
    "Volume"
  );
  console.log("-".repeat(90));

  for (const { account } of accounts) {
    const c = parseAffiliateConfig(account.data);
    console.log(
      c.affiliate.padEnd(46) +
      c.tierName.padEnd(10) +
      String(c.commissionBps).padEnd(6) +
      String(c.totalReferrals).padEnd(12) +
      String(c.totalVolume)
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage:");
    console.error("  node scripts/affiliate-stats.cjs <affiliate_pubkey>");
    console.error("  node scripts/affiliate-stats.cjs --all");
    process.exit(1);
  }

  if (args[0] === "--all") {
    await queryAll();
  } else {
    await queryOne(args[0]);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
