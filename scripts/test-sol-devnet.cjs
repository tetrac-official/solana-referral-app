/**
 * Test SOL payment split on devnet.
 *
 * Sends 0.01 SOL through the program's PDA and splits 80/20 to
 * merchant / affiliate.
 *
 * Run from project root:
 *   node scripts/test-sol-devnet.cjs
 */

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require(require("path").join(
  __dirname,
  "..",
  "web",
  "node_modules",
  "@solana",
  "web3.js",
));
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

// ── Config ──────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3");
const MERCHANT   = new PublicKey("GgUWyS5rsH4Z3Cdk1sYWy3TiJgzN8jk6MdMW4BbkU7MU");
const AFFILIATE  = new PublicKey("GgUWyS5rsH4Z3Cdk1sYWy3TiJgzN8jk6MdMW4BbkU7MU");
const AMOUNT_SOL = 0.01;
const RPC_URL    = "https://api.devnet.solana.com";

// ── Helpers ─────────────────────────────────────────────────────────
function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function findPDA(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function ixDiscriminator(name) {
  const hash = crypto.createHash("sha256").update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}

function encodeString(s) {
  const buf = Buffer.alloc(4 + s.length);
  buf.writeUInt32LE(s.length, 0);
  buf.write(s, 4, "utf-8");
  return buf;
}

function encodeU64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n), 0);
  return buf;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(`${os.homedir()}/.config/solana/id.json`);

  console.log("Payer:      ", payer.publicKey.toBase58());
  console.log("Merchant:   ", MERCHANT.toBase58());
  console.log("Affiliate:  ", AFFILIATE.toBase58());
  console.log("Program:    ", PROGRAM_ID.toBase58());
  console.log("Amount:     ", AMOUNT_SOL, "SOL");
  console.log();

  const [tokenAuthority, bump] = findPDA(
    [Buffer.from("token_authority")],
    PROGRAM_ID,
  );
  console.log("PDA:        ", tokenAuthority.toBase58(), `(bump ${bump})`);

  const [affiliateConfig] = findPDA(
    [Buffer.from("affiliate"), AFFILIATE.toBuffer()],
    PROGRAM_ID,
  );
  console.log("AffConfig:  ", affiliateConfig.toBase58());

  const referenceKp = Keypair.generate();
  const referenceKey = referenceKp.publicKey;
  console.log("Reference:  ", referenceKey.toBase58());

  const [referenceStorage] = findPDA(
    [Buffer.from("reference"), referenceKey.toBuffer()],
    PROGRAM_ID,
  );
  console.log("RefStorage: ", referenceStorage.toBase58());

  // Pre-flight
  const payerBal = await connection.getBalance(payer.publicKey);
  const merchantBal = await connection.getBalance(MERCHANT);
  console.log();
  console.log("Pre-flight balances:");
  console.log("  Payer:    ", payerBal / LAMPORTS_PER_SOL, "SOL");
  console.log("  Merchant: ", merchantBal / LAMPORTS_PER_SOL, "SOL");

  // Memo
  const memo = JSON.stringify({
    merchant_id: MERCHANT.toBase58(),
    affiliate_id: AFFILIATE.toBase58(),
  });

  const amountLamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);

  // Build receive_and_split_sol instruction
  const disc = ixDiscriminator("receive_and_split_sol");
  const data = Buffer.concat([
    disc,
    encodeString(memo),
    encodeU64(amountLamports),
  ]);

  const keys = [
    { pubkey: payer.publicKey,  isSigner: true,  isWritable: true  },
    { pubkey: tokenAuthority,   isSigner: false, isWritable: true  },
    { pubkey: MERCHANT,         isSigner: false, isWritable: true  },
    { pubkey: AFFILIATE,        isSigner: false, isWritable: true  },
    { pubkey: affiliateConfig,  isSigner: false, isWritable: true  },
    { pubkey: referenceKey,     isSigner: false, isWritable: false },
    { pubkey: referenceStorage, isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const tx = new Transaction();

  // 1) Transfer SOL payer → PDA
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tokenAuthority,
      lamports: amountLamports,
    }),
  );

  // 2) receive_and_split_sol
  tx.add({ programId: PROGRAM_ID, keys, data });

  console.log();
  console.log("Sending transaction...");
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
    });
    console.log("SUCCESS! Signature:", sig);
    console.log(`https://solscan.io/tx/${sig}?cluster=devnet`);
  } catch (err) {
    console.error("FAILED:", err.message);
    if (err.logs) {
      console.error("Logs:");
      err.logs.forEach((l) => console.error("  ", l));
    }
    process.exit(1);
  }

  // Post-flight
  await new Promise(r => setTimeout(r, 2000));
  const payerBalAfter = await connection.getBalance(payer.publicKey);
  const merchantBalAfter = await connection.getBalance(MERCHANT);
  console.log();
  console.log("Post-flight balances:");
  console.log("  Payer:     ", payerBalAfter / LAMPORTS_PER_SOL, "SOL");
  console.log("  Merchant:  ", merchantBalAfter / LAMPORTS_PER_SOL, "SOL");

  const merchantDelta = (merchantBalAfter - merchantBal) / LAMPORTS_PER_SOL;
  console.log();
  console.log("Merchant delta:", merchantDelta, "SOL");
  console.log("Expected:      ", AMOUNT_SOL, "SOL (merchant == affiliate, so receives 80% + 20% = 100%)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
