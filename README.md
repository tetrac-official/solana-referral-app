# Solana Pay Referral

Atomic on-chain payment splitter for SOL and USDC, with a tiered affiliate
commission system. One transaction transfers funds from the payer and splits
them between merchant and affiliate — no escrow, no backend, no callbacks.

## How it works

A single Solana program (`DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3` on
devnet) owns one global PDA (`seeds = [b"token_authority"]`) that holds funds
in flight. Every payment is two instructions in the same transaction:

1. `transfer` (or `transfer_sol`) — payer → PDA
2. `receive_and_split` (or `receive_and_split_sol`) — PDA → merchant + affiliate

If the split reverts, the transfer reverts. There are no "stuck funds" in
normal operation. A reference pubkey seeds a `ReferenceStorage` PDA, so reusing
a reference key fails on account init — trustless replay prevention.

### Affiliate tiers

Affiliates self-register on-chain via `register_affiliate` (no admin needed,
~0.002 SOL rent). Each affiliate has an `AffiliateConfig` PDA storing their
commission. The split percentage is read from this PDA at payment time.

| Tier    | BPS  | Commission |
|---------|------|------------|
| Starter | 500  | 5% (default on register) |
| Silver  | 1000 | 10% |
| Gold    | 1500 | 15% |

Manual promotion is admin-gated (`promote_affiliate`). Auto-promotion from
Starter → Silver fires inside `receive_and_split` / `receive_and_split_sol`
once an affiliate's referral count crosses `AUTO_PROMOTE_REFERRALS` (10) —
see [programId/src/lib.rs](programId/src/lib.rs#L15). Higher tiers (Gold)
require an admin call.

## Project layout

```
programId/   Anchor 0.32 program (Rust). Crate `program`, mod `referral`.
             lib.rs holds all instructions; IDL is hand-authored in web/idl/.
web/         Next.js 16 + Tailwind. Wallet-signed payment flow, affiliate
             self-register, transaction dashboard.
scripts/     Devnet test scripts (.cjs) + deploy scripts (.sh).
setup-dev.sh One-time machine setup: Solana CLI, BPF tools, wallet.
```

## Quick start (devnet)

```bash
# 1. Install Solana CLI + BPF tools (skip if you already have them)
./setup-dev.sh

# 2. Web client
cd web
yarn install
yarn dev                       # http://localhost:3000

# 3. End-to-end on-chain test (uses your ~/.config/solana/id.json)
cd ..
node scripts/test-affiliate-tiers.cjs
```

In the web UI:

- Toggle to **Devnet** in the header
- Click **Select Wallet** to connect Phantom or Solflare (set them to devnet too)
- Visit **/generator** to send a payment, or click **Register as Affiliate**
  in the affiliate panel to register the connected wallet

External Solana Pay QR scans are intentionally not supported — they only
execute the transfer leg and skip the on-chain split. All payments must be
signed in-app by a connected wallet.

## Common commands

### Web

```bash
cd web
yarn dev              # Next.js dev server (Turbopack)
yarn build            # production build
yarn lint             # eslint
yarn format           # prettier write
```

### Program

```bash
cd programId
cargo build-sbf       # produces target/deploy/program.so
                      # The keypair at target/deploy/program-keypair.json
                      # determines the program ID — DO NOT delete it.
```

### Deploy

```bash
./scripts/deploy-devnet.sh                # build + deploy to devnet
./scripts/deploy-devnet.sh --airdrop      # request 2 SOL first
./scripts/deploy-mainnet.sh               # build + deploy to mainnet-beta
```

After a fresh deploy, the USDC vault ATA must be created once — click
**Initialize USDC Vault** in the generator UI, or it auto-initializes on the
first run of [scripts/test-usdc-devnet.cjs](scripts/test-usdc-devnet.cjs).

### Devnet test scripts

```bash
# Full on-chain test suite — 31 tests, ~0.05–0.10 SOL per run
node scripts/test-suite.cjs              # run everything
node scripts/test-suite.cjs split        # filter: only tests with "split" in the name

# Individual smoke scripts (kept for ad-hoc use)
node scripts/test-affiliate-tiers.cjs    # register + tiered SOL split + read stats
node scripts/test-sol-devnet.cjs         # SOL split with affiliate
node scripts/test-usdc-devnet.cjs        # USDC vault init + split
node scripts/affiliate-stats.cjs --all   # list every registered affiliate
node scripts/affiliate-stats.cjs <pubkey>
node scripts/promote-affiliate.cjs       # admin-only tier change
```

`test-suite.cjs` is the canonical correctness check — it covers initialization,
self-registration (success + double-register failure), promotion (admin gate
+ bps cap), every tier's SOL/USDC split math, replay protection, minimum
amounts, memo validation (malformed, missing fields, invalid pubkeys,
separator-injection), affiliate pairing mismatches, and the admin-only sweep
gates. Promotion + sweep tests skip automatically when the runner is not the
admin.

All scripts hit devnet directly using `~/.config/solana/id.json` and reuse
`web/node_modules` for `@solana/web3.js` — no separate install needed.

## Deployed addresses

| What | Address |
|---|---|
| Program (devnet) | `DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3` |
| Admin / upgrade authority | `BYNtxb7zMereaMrmMcWCQx3G6Y1KZspnMJbiuqoh9MrF` |
| Devnet test merchant | `GgUWyS5rsH4Z3Cdk1sYWy3TiJgzN8jk6MdMW4BbkU7MU` |
| Devnet USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

Mainnet is not yet deployed.

## Constraints and gotchas

- **Minimum amounts** (anti-spam): SOL ≥ 1000 lamports, USDC ≥ 1000 units (0.001 USDC).
  Below these, the program returns `AmountBelowMinimum`.
- **Memo parser**: hand-rolled (not `serde_json`). Rejects `,`, `:`, `"`
  inside values as a separator-injection guard. Practical size limit is
  Solana's 1232-byte transaction cap minus the rest of the instruction —
  the program itself doesn't impose a fixed memo length.
- **Hand-authored IDL**: [web/idl/program.json](web/idl/program.json) is
  maintained by hand. Discriminators are `sha256("global:<snake_name>")[..8]`.
  If you regenerate via `anchor build`, diff every `address` and
  `discriminator` before committing.
- **Network toggle**: [web/providers/NetworkProvider.tsx](web/providers/NetworkProvider.tsx)
  is the single source of truth for devnet/mainnet — it drives both the wallet
  adapter and the RPC connection. Don't construct ad-hoc `Connection`s.
- **Rust mod name**: the on-chain instruction module is `pub mod referral`, not
  `pub mod program` — `program` collides with Anchor's `#[program]` macro
  internals. The Cargo crate name, the IDL `name`, and the deployed `.so` are
  still called `program`; only the internal Rust identifier differs.
- **Don't lose the keypair**: `programId/target/deploy/program-keypair.json`
  determines the program ID. Lose it and you lose upgrade authority.

## Architecture choices

The single shared vault PDA is intentional — per-merchant vaults were
considered and rejected because they balloon rent and force every merchant to
pre-initialize before accepting payments. Consequences:

- `initialize` is a one-time, program-wide call (not per-merchant). Anyone can
  pay the rent.
- The vault ATA is the canonical recipient for USDC; SOL flows through the
  PDA directly.
- `sweep` / `sweep_sol` (admin-only) exist as the only escape hatch if a split
  reverts after a transfer somehow lands.

## License

ISC.
