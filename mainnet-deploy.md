# Mainnet Deploy Guide

In-order checklist for shipping the Solana Pay Referral program to
mainnet-beta. Upgrade authority + admin = **Ledger** (`usb://ledger`).

**Program ID:** `DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3`
**Admin / upgrade authority:** `2v4XjdTjHK7qKEc8BkCeCWFrZmGSJv32ZGyv27zw3jc5` (Ledger)

---

## 1. Pre-flight

1. **Back up `programId/target/deploy/program-keypair.json`** offline (encrypted USB or password-manager attachment). This is the program's *address* keypair — never signs after deploy, but losing it forfeits the program ID. Unrelated to the Ledger.
2. **Ledger seed phrase is your only admin recovery.** Confirm the 24 words are stored offline (steel plate / paper in a safe). No file backup exists; lose the seed = lose admin forever.
3. **Enable blind signing** on the Ledger: open the Solana app → Settings → Blind signing → Enabled. Required because program-deploy chunks are unparseable on-device.
4. **Point Solana CLI at the Ledger and verify the pubkey:**
   ```bash
   solana config set --keypair usb://ledger --url mainnet-beta
   solana-keygen pubkey usb://ledger
   solana-keygen pubkey "usb://ledger?key=2"
   solana-keygen pubkey "usb://ledger?key=5/0" # Correct : Tested May 2026
   # Must print: 2v4XjdTjHK7qKEc8BkCeCWFrZmGSJv32ZGyv27zw3jc5
   ```
  
   ```bash
   solana config set --keypair "usb://ledger?key=5/0"
   solana address # confirm
   ```

5. **Fund the Ledger.** Fresh deploy ≈ 4.73 SOL, upgrade ≈ 0.5 SOL. Send to `2v4XjdTjHK7qKEc8BkCeCWFrZmGSJv32ZGyv27zw3jc5`, then:
   ```bash
   solana balance
   ```
6. **Confirm `declare_id!`** in `programId/src/lib.rs` matches the program ID above.
7. **Confirm `ADMIN` const** in `programId/src/lib.rs:19-24` decodes to `2v4XjdTjHK7qKEc8BkCeCWFrZmGSJv32ZGyv27zw3jc5` (else admin functions will be unreachable post-deploy).
8. **Build the .so:** see [solana-build.md](solana-build.md).

## 2. Deploy

Plug in the Ledger, unlock it, open the Solana app, then:

```bash
./scripts/deploy-mainnet.sh
```

The script switches CLI to mainnet-beta, builds, and calls `solana program deploy`. Because the CLI keypair is `usb://ledger`, the Ledger will prompt to sign every chunk transaction (~30+ prompts on a fresh deploy). Approve each one. Do not unplug.

**If the cable is flaky, use the buffer flow instead** (resumable):
```bash
cd programId
cargo build-sbf
solana program write-buffer target/deploy/program.so --url mainnet-beta
# Note the printed BUFFER_PUBKEY.
solana program deploy \
  --buffer <BUFFER_PUBKEY> \
  --program-id target/deploy/program-keypair.json \
  --upgrade-authority usb://ledger \
  --url mainnet-beta
```

Verify:
```bash
solana program show DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3 --url mainnet-beta
```
`Authority` must equal `2v4XjdTjHK7qKEc8BkCeCWFrZmGSJv32ZGyv27zw3jc5`. `ProgramData Address` must be set.

## 3. One-time on-chain init

The USDC vault ATA must exist before any USDC split lands.

**UI path:** `cd web && yarn dev` → toggle to **Mainnet** in the header → connect Ledger via Phantom/Solflare → click **Initialize USDC Vault**. One-time per program lifetime. SOL splits don't need this.

## 4. Smoke test (real money, small amounts)

Send the smallest valid amounts first.
- **SOL:** ≥ 1000 lamports (0.000001 SOL). Test with 0.001 SOL.
- **USDC:** ≥ 1000 micro (0.001 USDC). Test with 0.01 USDC.

1. Register a test affiliate via the web UI (`Register as Affiliate`).
2. Send a SOL split payment naming that affiliate.
3. Confirm on Solscan: payer → PDA → merchant + affiliate, all in one tx.
4. Repeat for USDC.
5. Read affiliate stats:
   ```bash
   node scripts/affiliate-stats.cjs <affiliate-pubkey>
   ```
   `total_referrals` and `total_volume` should reflect the test payments.

## 5. Wire TTC Box (the consumer)

In TTC's Vercel project settings, add:
```
NEXT_PUBLIC_REFERRAL_PROGRAM_ID=DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3
NEXT_PUBLIC_REFERRAL_MERCHANT=<TTC treasury wallet — same as X402_TREASURY_WALLET>
```

Copy the verified IDL into TTC if it's drifted:
```bash
cp web/idl/program.json ../TTC/next-ttc/src/lib/referral/idl.json
```
Diff `address` and every `discriminator` before committing — must match the deployed program.

## 6. Post-deploy verification

- `/testing/affiliate` on TTC: register + view payouts works against mainnet.
- `/testing/admin` on TTC: connect Ledger via wallet adapter → row promote → tx lands (Ledger prompts to sign).
- `/api/v1/subscription/activate-referral`: real subscription tx grants access end-to-end.

## Rollback

There is no atomic rollback. If a deployed version is broken:
1. Fix the Rust source.
2. Re-run `./scripts/deploy-mainnet.sh` — auto-detects existing program + upgrades in place (~0.5 SOL). Ledger signs.
3. Old account data (`AffiliateConfig`, `ReferenceStorage`) survives the upgrade; only the bytecode changes.

If the Ledger seed is lost: the program is frozen forever. No recovery path.

## Gotchas

- **Public RPC limits.** `getProgramAccounts` (admin panel) is rate-limited on free RPCs. Configure a paid endpoint via `NEXT_PUBLIC_SOLANA_RPC_URL` before opening the admin dashboard at scale.
- **External Solana Pay QR scans skip the split.** Don't expose a QR fallback for subscription purchases — only in-app wallet signing executes both instructions atomically.
- **Memo size cap.** Practical limit is Solana's 1232-byte tx cap; `merchant_id` + `affiliate_id` together with the rest of the ix should never get close.
- **Admin pubkey is hardcoded.** Rotating it (e.g. moving to a new Ledger) requires editing the byte array in `programId/src/lib.rs:19-24` and redeploying. There is no on-chain admin config.
- **Ledger blind signing must stay on.** Required for both deploys and admin ops (`promote_affiliate`, `sweep_*`). If disabled, every tx fails on the device.
