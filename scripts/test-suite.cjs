#!/usr/bin/env node
// Devnet test suite for the Solana Pay Referral program.
//
// Runs every test on-chain against the deployed program. Each run uses fresh
// ephemeral keypairs where possible, so tests are independent and re-runnable.
//
// Usage:
//   node scripts/test-suite.cjs              # run everything
//   node scripts/test-suite.cjs <substring>  # run only tests whose name contains it
//   node scripts/test-suite.cjs split        # e.g. only split tests
//
// Cost: ~0.05–0.10 SOL per full run on devnet (rent + fees, mostly refundable
// if you close the spawned accounts later — we don't bother).
//
// Loads payer from ~/.config/solana/id.json. If that wallet is the program
// admin (BYNtxb…9MrF), promote/sweep tests run; otherwise they're skipped.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const W3 = require(path.join(__dirname, "..", "web", "node_modules", "@solana", "web3.js"));
const SPL = require(path.join(__dirname, "..", "web", "node_modules", "@solana", "spl-token"));

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = W3;
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
} = SPL;

// ─── Config ────────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3");
const ADMIN = new PublicKey("2v4XjdTjHK7qKEc8BkCeCWFrZmGSJv32ZGyv27zw3jc5");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC_DECIMALS = 6;
const RPC_URL = "https://api.devnet.solana.com";
const conn = new Connection(RPC_URL, "confirmed");

// Anchor error codes mirrored from programId/src/lib.rs (ErrorCode enum).
const ERR = {
  ArithmeticOverflow: 6000,
  InvalidMemoFormat: 6001,
  MissingMerchantId: 6002,
  InvalidMerchantPubkey: 6003,
  InvalidAffiliatePubkey: 6004,
  MerchantMismatch: 6005,
  AffiliateMismatch: 6006,
  InvalidAmount: 6007,
  AmountBelowMinimum: 6008,
  Unauthorized: 6009,
  CommissionTooHigh: 6010,
};

const KEYPAIR_PATH = path.join(os.homedir(), ".config", "solana", "id.json");
const PAYER = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
);
const IS_ADMIN = PAYER.publicKey.equals(ADMIN);

// ─── Discriminators (sha256("global:<snake_name>")[..8]) ───────────────────
const disc = (name) =>
  crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

// ─── PDA derivation ────────────────────────────────────────────────────────
const tokenAuthorityPda = () =>
  PublicKey.findProgramAddressSync([Buffer.from("token_authority")], PROGRAM_ID)[0];
const affiliateConfigPda = (affiliate) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("affiliate"), affiliate.toBuffer()],
    PROGRAM_ID,
  )[0];
const referenceStoragePda = (reference) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("reference"), reference.toBuffer()],
    PROGRAM_ID,
  )[0];

// ─── Encoding helpers ──────────────────────────────────────────────────────
function encString(s) {
  const b = Buffer.from(s, "utf-8");
  const buf = Buffer.alloc(4 + b.length);
  buf.writeUInt32LE(b.length, 0);
  b.copy(buf, 4);
  return buf;
}
const encU64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
};
const encU16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
};
const encU8 = (n) => Buffer.from([n & 0xff]);

// ─── Instruction builders ──────────────────────────────────────────────────
function ixRegisterAffiliate(affiliate) {
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: affiliate, isSigner: true, isWritable: true },
      { pubkey: affiliateConfigPda(affiliate), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("register_affiliate"),
  };
}

function ixPromoteAffiliate(adminPk, affiliatePk, newTier, newBps) {
  return {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: adminPk, isSigner: true, isWritable: true },
      { pubkey: affiliateConfigPda(affiliatePk), isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("promote_affiliate"), encU8(newTier), encU16(newBps)]),
  };
}

// Build the receive_and_split_sol instruction. Pass `affiliate=null` for a
// no-affiliate split. Pass an explicit `accountsOverride` to test mismatches.
function ixReceiveAndSplitSol({
  payer,
  merchant,
  affiliate,
  affiliateConfigOverride,
  memo,
  amount,
  reference,
}) {
  const accs = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: tokenAuthorityPda(), isSigner: false, isWritable: true },
    { pubkey: merchant, isSigner: false, isWritable: true },
  ];
  if (affiliate) {
    accs.push({ pubkey: affiliate, isSigner: false, isWritable: true });
    accs.push({
      pubkey: affiliateConfigOverride || affiliateConfigPda(affiliate),
      isSigner: false,
      isWritable: true,
    });
  } else {
    // Anchor convention for `Option<Account>` = None: pass the program ID
    // as a placeholder at the optional account's position.
    accs.push({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false });
    accs.push({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false });
  }
  accs.push({ pubkey: reference, isSigner: false, isWritable: false });
  accs.push({ pubkey: referenceStoragePda(reference), isSigner: false, isWritable: true });
  accs.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
  return {
    programId: PROGRAM_ID,
    keys: accs,
    data: Buffer.concat([disc("receive_and_split_sol"), encString(memo), encU64(amount)]),
  };
}

function ixReceiveAndSplit({
  payer,
  vaultAta,
  merchantAta,
  affiliateAta,
  affiliateConfig,
  memo,
  amount,
  reference,
}) {
  const accs = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: tokenAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: merchantAta, isSigner: false, isWritable: true },
  ];
  if (affiliateAta) {
    accs.push({ pubkey: affiliateAta, isSigner: false, isWritable: true });
    accs.push({ pubkey: affiliateConfig, isSigner: false, isWritable: true });
  } else {
    // Optional-None placeholder (see ixReceiveAndSplitSol).
    accs.push({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false });
    accs.push({ pubkey: PROGRAM_ID, isSigner: false, isWritable: false });
  }
  accs.push({ pubkey: USDC_MINT, isSigner: false, isWritable: false });
  accs.push({ pubkey: reference, isSigner: false, isWritable: false });
  accs.push({ pubkey: referenceStoragePda(reference), isSigner: false, isWritable: true });
  accs.push({ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false });
  accs.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
  return {
    programId: PROGRAM_ID,
    keys: accs,
    data: Buffer.concat([disc("receive_and_split"), encString(memo), encU64(amount)]),
  };
}

function buildSolSplitTx({ payer, merchant, affiliate, amount, memo, reference }) {
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: tokenAuthorityPda(),
      lamports: amount,
    }),
  );
  tx.add(ixReceiveAndSplitSol({ payer, merchant, affiliate, memo, amount, reference }));
  return tx;
}

function makeMemo(merchantPk, affiliatePk) {
  const o = { merchant_id: merchantPk.toBase58() };
  if (affiliatePk) o.affiliate_id = affiliatePk.toBase58();
  return JSON.stringify(o);
}

// ─── Test framework ────────────────────────────────────────────────────────
const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const filter = process.argv[2] || "";
const results = { pass: 0, fail: 0, skip: 0, failures: [] };

class SkipError extends Error {}

function skip(msg) {
  throw new SkipError(msg);
}

async function test(name, fn) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    results.pass++;
    console.log(C.green("PASS"));
  } catch (e) {
    if (e instanceof SkipError) {
      results.skip++;
      console.log(C.yellow(`SKIP (${e.message})`));
      return;
    }
    results.fail++;
    results.failures.push({ name, err: e.message });
    console.log(C.red("FAIL"));
    console.log(C.dim("    " + String(e.message).split("\n").join("\n    ")));
  }
}

function section(title) {
  console.log(`\n${C.cyan("━━ " + title + " ━━")}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg || ""}`);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg || "values differ"}: expected ${expected}, got ${actual}`);
}

// Run a tx promise that's expected to fail with a specific Anchor error code.
// Looks for the error number in tx logs OR the matching custom-program-error
// hex in the message string.
async function expectError(promise, expectedCode, label = "") {
  const codeName =
    Object.entries(ERR).find(([, v]) => v === expectedCode)?.[0] || String(expectedCode);
  try {
    await promise;
  } catch (e) {
    const numStr = `Error Number: ${expectedCode}`;
    const hexStr = `0x${expectedCode.toString(16)}`;
    const inLogs = (e.logs || []).some((l) => l.includes(numStr) || l.includes(hexStr));
    const inMsg = String(e.message).includes(hexStr) || String(e.message).includes(numStr);
    if (inLogs || inMsg) return;
    throw new Error(
      `${label}expected ${codeName} (${expectedCode}/${hexStr}), got: ${e.message}`,
    );
  }
  throw new Error(`${label}expected ${codeName} (${expectedCode}) but tx succeeded`);
}

async function expectAnyError(promise, label = "") {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`${label}expected tx to fail but it succeeded`);
}

// ─── Funding ───────────────────────────────────────────────────────────────
async function fund(target, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: PAYER.publicKey,
      toPubkey: target,
      lamports,
    }),
  );
  await sendAndConfirmTransaction(conn, tx, [PAYER], { commitment: "confirmed" });
}

// Create + register a fresh affiliate and return its keypair.
async function freshRegisteredAffiliate() {
  const kp = Keypair.generate();
  await fund(kp.publicKey, 0.005 * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(ixRegisterAffiliate(kp.publicKey));
  await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
  return kp;
}

// Read AffiliateConfig, returns null if not initialized.
async function readAffiliateConfig(affiliatePk) {
  const info = await conn.getAccountInfo(affiliateConfigPda(affiliatePk));
  if (!info) return null;
  const d = info.data;
  let off = 8; // discriminator
  const affiliate = new PublicKey(d.slice(off, off + 32));
  off += 32;
  const commissionBps = d.readUInt16LE(off);
  off += 2;
  const tier = d[off];
  off += 1;
  const totalReferrals = d.readUInt32LE(off);
  off += 4;
  const totalVolume = Number(d.readBigUInt64LE(off));
  return { affiliate, commissionBps, tier, totalReferrals, totalVolume };
}

// Ensure the runner has a USDC ATA with at least `minRaw` units; returns the ATA.
// On devnet you can mint test USDC at https://spl-token-faucet.com if needed.
async function ensurePayerUsdcBalance(minRaw) {
  const ata = await getAssociatedTokenAddress(USDC_MINT, PAYER.publicKey);
  let acct;
  try {
    acct = await getAccount(conn, ata);
  } catch {
    return null;
  }
  if (Number(acct.amount) < minRaw) return null;
  return ata;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(C.cyan("Solana Pay Referral — devnet test suite"));
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(
    `Payer:   ${PAYER.publicKey.toBase58()}` +
      (IS_ADMIN ? " (admin)" : C.yellow(" (not admin — admin tests will be skipped)")),
  );
  const bal = await conn.getBalance(PAYER.publicKey);
  console.log(`Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    console.log(
      C.yellow(
        "Warning: balance < 0.05 SOL. Some tests may fail. " +
          "Try: solana airdrop 1 --url devnet",
      ),
    );
  }
  if (filter) console.log(C.dim(`Filter: "${filter}"`));

  // ─── Initialize ──────────────────────────────────────────────────────────
  section("Initialize");

  await test("vault is already initialized (re-init fails)", async () => {
    const usdcVault = await getAssociatedTokenAddress(
      USDC_MINT,
      tokenAuthorityPda(),
      true,
    );
    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: PAYER.publicKey, isSigner: true, isWritable: true },
        { pubkey: tokenAuthorityPda(), isSigner: false, isWritable: true },
        { pubkey: USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: usdcVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: disc("initialize"),
    };
    const tx = new Transaction().add(ix);
    await expectAnyError(
      sendAndConfirmTransaction(conn, tx, [PAYER]),
      "init on existing vault: ",
    );
  });

  // ─── Affiliate registration ──────────────────────────────────────────────
  section("Affiliate registration");

  await test("fresh affiliate self-registers at Starter (5%, tier 0)", async () => {
    const aff = Keypair.generate();
    await fund(aff.publicKey, 0.005 * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(ixRegisterAffiliate(aff.publicKey));
    await sendAndConfirmTransaction(conn, tx, [aff]);

    const cfg = await readAffiliateConfig(aff.publicKey);
    assert(cfg !== null, "AffiliateConfig should exist after register");
    assertEq(cfg.commissionBps, 500, "commissionBps");
    assertEq(cfg.tier, 0, "tier");
    assertEq(cfg.totalReferrals, 0, "totalReferrals");
    assertEq(cfg.totalVolume, 0, "totalVolume");
    assert(cfg.affiliate.equals(aff.publicKey), "affiliate pubkey mismatch");
  });

  await test("re-registering same affiliate fails (PDA already in use)", async () => {
    const aff = await freshRegisteredAffiliate();
    const tx = new Transaction().add(ixRegisterAffiliate(aff.publicKey));
    await expectAnyError(
      sendAndConfirmTransaction(conn, tx, [aff]),
      "double-register: ",
    );
  });

  // ─── Promotion (admin-only) ──────────────────────────────────────────────
  section("Promotion");

  await test("admin promotes Starter → Silver (1000 bps)", async () => {
    if (!IS_ADMIN) skip("not admin");
    const aff = await freshRegisteredAffiliate();
    const tx = new Transaction().add(
      ixPromoteAffiliate(PAYER.publicKey, aff.publicKey, 1, 1000),
    );
    await sendAndConfirmTransaction(conn, tx, [PAYER]);
    const cfg = await readAffiliateConfig(aff.publicKey);
    assertEq(cfg.tier, 1, "tier");
    assertEq(cfg.commissionBps, 1000, "commissionBps");
  });

  await test("admin promotes Silver → Gold (1500 bps)", async () => {
    if (!IS_ADMIN) skip("not admin");
    const aff = await freshRegisteredAffiliate();
    let tx = new Transaction().add(
      ixPromoteAffiliate(PAYER.publicKey, aff.publicKey, 2, 1500),
    );
    await sendAndConfirmTransaction(conn, tx, [PAYER]);
    const cfg = await readAffiliateConfig(aff.publicKey);
    assertEq(cfg.tier, 2, "tier");
    assertEq(cfg.commissionBps, 1500, "commissionBps");
  });

  await test("non-admin cannot promote (Unauthorized)", async () => {
    const aff = await freshRegisteredAffiliate();
    const fake = Keypair.generate();
    await fund(fake.publicKey, 0.005 * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(
      ixPromoteAffiliate(fake.publicKey, aff.publicKey, 1, 1000),
    );
    await expectError(
      sendAndConfirmTransaction(conn, tx, [fake]),
      ERR.Unauthorized,
      "non-admin promote: ",
    );
  });

  await test("promote rejects bps > 2000 (CommissionTooHigh)", async () => {
    if (!IS_ADMIN) skip("not admin");
    const aff = await freshRegisteredAffiliate();
    const tx = new Transaction().add(
      ixPromoteAffiliate(PAYER.publicKey, aff.publicKey, 1, 2500),
    );
    await expectError(
      sendAndConfirmTransaction(conn, tx, [PAYER]),
      ERR.CommissionTooHigh,
      "bps > 2000: ",
    );
  });

  // ─── SOL split ───────────────────────────────────────────────────────────
  section("SOL split");

  // Split with no affiliate — merchant gets 100%
  await test("SOL split: no affiliate → 100% to merchant", async () => {
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const amount = 0.001 * LAMPORTS_PER_SOL;
    // Fund the merchant a tiny bit so its balance shows up as "rent-allocated"
    // (System transfer to a new account works without needing an existing acct).
    const memo = makeMemo(merchant, null);
    const tx = buildSolSplitTx({
      payer: PAYER.publicKey,
      merchant,
      affiliate: null,
      amount,
      memo,
      reference,
    });
    await sendAndConfirmTransaction(conn, tx, [PAYER]);
    const merchBal = await conn.getBalance(merchant);
    assertEq(merchBal, amount, "merchant should receive 100%");
  });

  // Split with affiliate at 5% (Starter)
  await test("SOL split: 5% Starter → 95/5", async () => {
    const aff = await freshRegisteredAffiliate(); // Starter @ 500 bps
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const amount = 0.01 * LAMPORTS_PER_SOL; // 10_000_000 lamports
    const memo = makeMemo(merchant, aff.publicKey);
    const affBalPre = await conn.getBalance(aff.publicKey);
    const tx = buildSolSplitTx({
      payer: PAYER.publicKey,
      merchant,
      affiliate: aff.publicKey,
      amount,
      memo,
      reference,
    });
    await sendAndConfirmTransaction(conn, tx, [PAYER]);

    const merchBal = await conn.getBalance(merchant);
    const affBal = await conn.getBalance(aff.publicKey);
    assertEq(merchBal, amount * 0.95, "merchant 95%");
    assertEq(affBal - affBalPre, amount * 0.05, "affiliate 5%");
  });

  // Split with affiliate at 10% (Silver, after promotion)
  await test("SOL split: 10% Silver → 90/10", async () => {
    if (!IS_ADMIN) skip("requires admin to promote");
    const aff = await freshRegisteredAffiliate();
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(ixPromoteAffiliate(PAYER.publicKey, aff.publicKey, 1, 1000)),
      [PAYER],
    );
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const amount = 0.01 * LAMPORTS_PER_SOL;
    const memo = makeMemo(merchant, aff.publicKey);
    const affBalPre = await conn.getBalance(aff.publicKey);
    await sendAndConfirmTransaction(
      conn,
      buildSolSplitTx({
        payer: PAYER.publicKey,
        merchant,
        affiliate: aff.publicKey,
        amount,
        memo,
        reference,
      }),
      [PAYER],
    );
    assertEq(await conn.getBalance(merchant), amount * 0.9, "merchant 90%");
    assertEq(
      (await conn.getBalance(aff.publicKey)) - affBalPre,
      amount * 0.1,
      "affiliate 10%",
    );
  });

  // Split with affiliate at 15% (Gold)
  await test("SOL split: 15% Gold → 85/15", async () => {
    if (!IS_ADMIN) skip("requires admin to promote");
    const aff = await freshRegisteredAffiliate();
    await sendAndConfirmTransaction(
      conn,
      new Transaction().add(ixPromoteAffiliate(PAYER.publicKey, aff.publicKey, 2, 1500)),
      [PAYER],
    );
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const amount = 0.01 * LAMPORTS_PER_SOL;
    const memo = makeMemo(merchant, aff.publicKey);
    const affBalPre = await conn.getBalance(aff.publicKey);
    await sendAndConfirmTransaction(
      conn,
      buildSolSplitTx({
        payer: PAYER.publicKey,
        merchant,
        affiliate: aff.publicKey,
        amount,
        memo,
        reference,
      }),
      [PAYER],
    );
    assertEq(await conn.getBalance(merchant), amount * 0.85, "merchant 85%");
    assertEq(
      (await conn.getBalance(aff.publicKey)) - affBalPre,
      amount * 0.15,
      "affiliate 15%",
    );
  });

  // Stats increment
  await test("SOL split: stats increment (referrals +1, volume += amount)", async () => {
    const aff = await freshRegisteredAffiliate();
    const before = await readAffiliateConfig(aff.publicKey);
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const amount = 0.001 * LAMPORTS_PER_SOL;
    await sendAndConfirmTransaction(
      conn,
      buildSolSplitTx({
        payer: PAYER.publicKey,
        merchant,
        affiliate: aff.publicKey,
        amount,
        memo: makeMemo(merchant, aff.publicKey),
        reference,
      }),
      [PAYER],
    );
    const after = await readAffiliateConfig(aff.publicKey);
    assertEq(after.totalReferrals, before.totalReferrals + 1, "referrals");
    assertEq(after.totalVolume, before.totalVolume + amount, "volume");
  });

  // Replay protection
  await test("SOL split: reusing reference fails (replay protection)", async () => {
    const aff = await freshRegisteredAffiliate();
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const amount = 0.001 * LAMPORTS_PER_SOL;
    const memo = makeMemo(merchant, aff.publicKey);
    await sendAndConfirmTransaction(
      conn,
      buildSolSplitTx({
        payer: PAYER.publicKey,
        merchant,
        affiliate: aff.publicKey,
        amount,
        memo,
        reference,
      }),
      [PAYER],
    );
    await expectAnyError(
      sendAndConfirmTransaction(
        conn,
        buildSolSplitTx({
          payer: PAYER.publicKey,
          merchant,
          affiliate: aff.publicKey,
          amount,
          memo,
          reference,
        }),
        [PAYER],
      ),
      "replay: ",
    );
  });

  await test("SOL split: amount below minimum (999) → AmountBelowMinimum", async () => {
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    await expectError(
      sendAndConfirmTransaction(
        conn,
        buildSolSplitTx({
          payer: PAYER.publicKey,
          merchant,
          affiliate: null,
          amount: 999,
          memo: makeMemo(merchant, null),
          reference,
        }),
        [PAYER],
      ),
      ERR.AmountBelowMinimum,
      "below-min SOL: ",
    );
  });

  await test("SOL split: merchant token account owner mismatch → MerchantMismatch", async () => {
    // Memo says merchant=A, but we pass account B as the merchant.
    const realMerchant = Keypair.generate().publicKey;
    const wrongMerchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const memo = makeMemo(realMerchant, null);
    const tx = new Transaction();
    tx.add(
      SystemProgram.transfer({
        fromPubkey: PAYER.publicKey,
        toPubkey: tokenAuthorityPda(),
        lamports: 0.001 * LAMPORTS_PER_SOL,
      }),
    );
    tx.add(
      ixReceiveAndSplitSol({
        payer: PAYER.publicKey,
        merchant: wrongMerchant,
        affiliate: null,
        memo,
        amount: 0.001 * LAMPORTS_PER_SOL,
        reference,
      }),
    );
    await expectError(
      sendAndConfirmTransaction(conn, tx, [PAYER]),
      ERR.MerchantMismatch,
      "merchant key mismatch: ",
    );
  });

  // ─── Affiliate mismatch / pairing ────────────────────────────────────────
  section("Affiliate pairing");

  await test("memo says affiliate but no affiliate accounts passed → AffiliateMismatch", async () => {
    const aff = await freshRegisteredAffiliate();
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const memo = makeMemo(merchant, aff.publicKey);
    const tx = new Transaction();
    tx.add(
      SystemProgram.transfer({
        fromPubkey: PAYER.publicKey,
        toPubkey: tokenAuthorityPda(),
        lamports: 0.001 * LAMPORTS_PER_SOL,
      }),
    );
    // affiliate=null deliberately omits the accounts
    tx.add(
      ixReceiveAndSplitSol({
        payer: PAYER.publicKey,
        merchant,
        affiliate: null,
        memo,
        amount: 0.001 * LAMPORTS_PER_SOL,
        reference,
      }),
    );
    await expectError(
      sendAndConfirmTransaction(conn, tx, [PAYER]),
      ERR.AffiliateMismatch,
      "missing affiliate accts: ",
    );
  });

  await test("affiliate account passed but memo has no affiliate_id → AffiliateMismatch", async () => {
    const aff = await freshRegisteredAffiliate();
    const merchant = Keypair.generate().publicKey;
    const reference = Keypair.generate().publicKey;
    const memo = makeMemo(merchant, null);
    const tx = new Transaction();
    tx.add(
      SystemProgram.transfer({
        fromPubkey: PAYER.publicKey,
        toPubkey: tokenAuthorityPda(),
        lamports: 0.001 * LAMPORTS_PER_SOL,
      }),
    );
    tx.add(
      ixReceiveAndSplitSol({
        payer: PAYER.publicKey,
        merchant,
        affiliate: aff.publicKey,
        memo,
        amount: 0.001 * LAMPORTS_PER_SOL,
        reference,
      }),
    );
    await expectError(
      sendAndConfirmTransaction(conn, tx, [PAYER]),
      ERR.AffiliateMismatch,
      "extra affiliate accts: ",
    );
  });

  await test(
    "affiliate config for wrong affiliate → AffiliateMismatch",
    async () => {
      const aff = await freshRegisteredAffiliate();
      const otherAff = await freshRegisteredAffiliate();
      const merchant = Keypair.generate().publicKey;
      const reference = Keypair.generate().publicKey;
      const memo = makeMemo(merchant, aff.publicKey);
      const tx = new Transaction();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: PAYER.publicKey,
          toPubkey: tokenAuthorityPda(),
          lamports: 0.001 * LAMPORTS_PER_SOL,
        }),
      );
      tx.add(
        ixReceiveAndSplitSol({
          payer: PAYER.publicKey,
          merchant,
          affiliate: aff.publicKey,
          affiliateConfigOverride: affiliateConfigPda(otherAff.publicKey),
          memo,
          amount: 0.001 * LAMPORTS_PER_SOL,
          reference,
        }),
      );
      await expectError(
        sendAndConfirmTransaction(conn, tx, [PAYER]),
        ERR.AffiliateMismatch,
        "wrong-affiliate config: ",
      );
    },
  );

  // ─── Memo validation ─────────────────────────────────────────────────────
  section("Memo validation");

  async function memoTest(name, badMemo, expectedErr) {
    await test(name, async () => {
      const merchant = Keypair.generate().publicKey;
      const reference = Keypair.generate().publicKey;
      const tx = new Transaction();
      tx.add(
        SystemProgram.transfer({
          fromPubkey: PAYER.publicKey,
          toPubkey: tokenAuthorityPda(),
          lamports: 0.001 * LAMPORTS_PER_SOL,
        }),
      );
      tx.add(
        ixReceiveAndSplitSol({
          payer: PAYER.publicKey,
          merchant,
          affiliate: null,
          memo: badMemo,
          amount: 0.001 * LAMPORTS_PER_SOL,
          reference,
        }),
      );
      await expectError(
        sendAndConfirmTransaction(conn, tx, [PAYER]),
        expectedErr,
        `memo "${badMemo}": `,
      );
    });
  }

  await memoTest("memo missing braces", "merchant_id:foo", ERR.InvalidMemoFormat);
  await memoTest("memo missing colon", '{"merchant_id"}', ERR.InvalidMemoFormat);
  await memoTest("memo missing merchant_id", '{"foo":"bar"}', ERR.MissingMerchantId);
  await memoTest(
    "memo invalid merchant pubkey",
    '{"merchant_id":"not-a-pubkey"}',
    ERR.InvalidMerchantPubkey,
  );
  await memoTest(
    "memo invalid affiliate pubkey",
    '{"merchant_id":"GgUWyS5rsH4Z3Cdk1sYWy3TiJgzN8jk6MdMW4BbkU7MU","affiliate_id":"junk"}',
    ERR.InvalidAffiliatePubkey,
  );
  await memoTest(
    "memo separator injection (comma in value)",
    '{"merchant_id":"foo,bar"}',
    ERR.InvalidMemoFormat,
  );
  await memoTest(
    "memo separator injection (quote in value)",
    '{"merchant_id":"foo"bar"}',
    ERR.InvalidMemoFormat,
  );

  // ─── USDC split ──────────────────────────────────────────────────────────
  section("USDC split");

  const usdcAta = await ensurePayerUsdcBalance(50_000); // need ~0.05 USDC for 5 tests
  if (!usdcAta) {
    console.log(
      C.yellow(
        "  skipping USDC tests — payer needs >= 0.05 USDC at " +
          USDC_MINT.toBase58() +
          ". Mint at https://spl-token-faucet.com",
      ),
    );
  } else {
    const vaultAta = await getAssociatedTokenAddress(USDC_MINT, tokenAuthorityPda(), true);

    async function buildUsdcSplitTx({
      merchantPk,
      merchantAta,
      affiliate,
      affiliateAta,
      amountRaw,
      memo,
      reference,
    }) {
      const tx = new Transaction();
      // Pre-create ATAs if missing (idempotent — Anchor uses init_if_needed elsewhere,
      // but here we use createAssociatedTokenAccountInstruction with safe checks).
      const merchantAcct = await conn.getAccountInfo(merchantAta);
      if (!merchantAcct) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            PAYER.publicKey,
            merchantAta,
            merchantPk,
            USDC_MINT,
          ),
        );
      }
      if (affiliate) {
        const affAcct = await conn.getAccountInfo(affiliateAta);
        if (!affAcct) {
          tx.add(
            createAssociatedTokenAccountInstruction(
              PAYER.publicKey,
              affiliateAta,
              affiliate,
              USDC_MINT,
            ),
          );
        }
      }
      // Transfer USDC payer → vault
      tx.add(
        createTransferCheckedInstruction(
          usdcAta,
          USDC_MINT,
          vaultAta,
          PAYER.publicKey,
          amountRaw,
          USDC_DECIMALS,
        ),
      );
      // Split
      tx.add(
        ixReceiveAndSplit({
          payer: PAYER.publicKey,
          vaultAta,
          merchantAta,
          affiliateAta: affiliate ? affiliateAta : null,
          affiliateConfig: affiliate ? affiliateConfigPda(affiliate) : null,
          memo,
          amount: amountRaw,
          reference,
        }),
      );
      return tx;
    }

    await test("USDC split: no affiliate → 100% to merchant", async () => {
      const merchantKp = Keypair.generate();
      const merchantAta = await getAssociatedTokenAddress(USDC_MINT, merchantKp.publicKey);
      const reference = Keypair.generate().publicKey;
      const amountRaw = 1000; // 0.001 USDC
      const tx = await buildUsdcSplitTx({
        merchantPk: merchantKp.publicKey,
        merchantAta,
        affiliate: null,
        affiliateAta: null,
        amountRaw,
        memo: makeMemo(merchantKp.publicKey, null),
        reference,
      });
      await sendAndConfirmTransaction(conn, tx, [PAYER]);
      const acct = await getAccount(conn, merchantAta);
      assertEq(Number(acct.amount), amountRaw, "merchant USDC 100%");
    });

    await test("USDC split: 5% Starter → 95/5 raw", async () => {
      const aff = await freshRegisteredAffiliate(); // Starter
      const merchantKp = Keypair.generate();
      const merchantAta = await getAssociatedTokenAddress(USDC_MINT, merchantKp.publicKey);
      const affiliateAta = await getAssociatedTokenAddress(USDC_MINT, aff.publicKey);
      const reference = Keypair.generate().publicKey;
      const amountRaw = 10_000; // 0.01 USDC
      const tx = await buildUsdcSplitTx({
        merchantPk: merchantKp.publicKey,
        merchantAta,
        affiliate: aff.publicKey,
        affiliateAta,
        amountRaw,
        memo: makeMemo(merchantKp.publicKey, aff.publicKey),
        reference,
      });
      await sendAndConfirmTransaction(conn, tx, [PAYER]);
      const m = await getAccount(conn, merchantAta);
      const a = await getAccount(conn, affiliateAta);
      assertEq(Number(m.amount), 9500, "merchant 9500 raw");
      assertEq(Number(a.amount), 500, "affiliate 500 raw");
    });

    await test("USDC split: amount below minimum (999) → AmountBelowMinimum", async () => {
      const merchantKp = Keypair.generate();
      const merchantAta = await getAssociatedTokenAddress(USDC_MINT, merchantKp.publicKey);
      const reference = Keypair.generate().publicKey;
      const tx = await buildUsdcSplitTx({
        merchantPk: merchantKp.publicKey,
        merchantAta,
        affiliate: null,
        affiliateAta: null,
        amountRaw: 999,
        memo: makeMemo(merchantKp.publicKey, null),
        reference,
      });
      await expectError(
        sendAndConfirmTransaction(conn, tx, [PAYER]),
        ERR.AmountBelowMinimum,
        "below-min USDC: ",
      );
    });

    await test("USDC split: merchant ATA owner mismatch → MerchantMismatch", async () => {
      // Memo names merchant A, but the merchant_token_account belongs to B.
      const realMerchant = Keypair.generate();
      const wrongMerchant = Keypair.generate();
      const wrongAta = await getAssociatedTokenAddress(USDC_MINT, wrongMerchant.publicKey);
      const reference = Keypair.generate().publicKey;
      const tx = await buildUsdcSplitTx({
        merchantPk: wrongMerchant.publicKey, // creates wrongAta if missing
        merchantAta: wrongAta,
        affiliate: null,
        affiliateAta: null,
        amountRaw: 1000,
        memo: makeMemo(realMerchant.publicKey, null), // memo says realMerchant
        reference,
      });
      await expectError(
        sendAndConfirmTransaction(conn, tx, [PAYER]),
        ERR.MerchantMismatch,
        "merchant ATA owner mismatch: ",
      );
    });
  }

  // ─── Sweep (admin-only) ──────────────────────────────────────────────────
  section("Sweep");

  await test("non-admin cannot sweep_sol (Unauthorized)", async () => {
    const fake = Keypair.generate();
    await fund(fake.publicKey, 0.005 * LAMPORTS_PER_SOL);
    const dest = Keypair.generate().publicKey;
    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: fake.publicKey, isSigner: true, isWritable: true },
        { pubkey: tokenAuthorityPda(), isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: disc("sweep_sol"),
    };
    const tx = new Transaction().add(ix);
    await expectError(
      sendAndConfirmTransaction(conn, tx, [fake]),
      ERR.Unauthorized,
      "non-admin sweep_sol: ",
    );
  });

  await test("non-admin cannot sweep USDC (Unauthorized)", async () => {
    if (!usdcAta) skip("no USDC ATA on payer to use as destination");
    const fake = Keypair.generate();
    await fund(fake.publicKey, 0.005 * LAMPORTS_PER_SOL);
    const vaultAta = await getAssociatedTokenAddress(USDC_MINT, tokenAuthorityPda(), true);
    // Anchor validates account types before the function body, so the
    // destination must be a real token account or AccountNotInitialized
    // fires first. Reuse the payer's existing USDC ATA.
    const ix = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: fake.publicKey, isSigner: true, isWritable: true },
        { pubkey: tokenAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: usdcAta, isSigner: false, isWritable: true },
        { pubkey: USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: disc("sweep"),
    };
    const tx = new Transaction().add(ix);
    await expectError(
      sendAndConfirmTransaction(conn, tx, [fake]),
      ERR.Unauthorized,
      "non-admin sweep: ",
    );
  });

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log();
  console.log(C.cyan("━━ Summary ━━"));
  console.log(
    `  ${C.green(`${results.pass} passed`)}, ${
      results.fail > 0 ? C.red(`${results.fail} failed`) : "0 failed"
    }, ${results.skip > 0 ? C.yellow(`${results.skip} skipped`) : "0 skipped"}`,
  );
  if (results.failures.length) {
    console.log(C.red("\nFailures:"));
    for (const f of results.failures) {
      console.log(C.red(`  • ${f.name}`));
      console.log(C.dim(`    ${f.err.split("\n").join("\n    ")}`));
    }
  }
  process.exit(results.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red("\nSUITE CRASHED:"), e);
  process.exit(2);
});
