# CLAUDE.md

Solana Pay Referral — atomic SOL/USDC splitter with tiered affiliate commissions (5/10/15%).

## Deployed (devnet)
- Program: `DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3`
- Admin / upgrade authority: `BYNtxb7zMereaMrmMcWCQx3G6Y1KZspnMJbiuqoh9MrF`

## Do
- Run `node scripts/test-suite.cjs` after every program or IDL change (31 on-chain tests, ~0.07 SOL/run).
- Read `declare_id!` in `programId/src/lib.rs` to confirm program ID — don't trust directory or module names.
- For Anchor `Option<Account>=None` in raw instructions, pass `PROGRAM_ID` as the placeholder at that account's slot.
- Route all RPC through `web/providers/NetworkProvider.tsx` — single source of truth for network.
- If regenerating IDL via `anchor build`, diff `address` and every `discriminator` against `web/idl/program.json` before committing.

## Don't
- Delete or overwrite `programId/target/deploy/program-keypair.json` (losing it = losing upgrade authority), `.env*`, `*.key`, `*.pem`.
- Rename Rust `pub mod referral` to `program` — collides with Anchor's `#[program]` macro and the build fails with 18 errors.
- Reintroduce the QR / Solana Pay URL flow — removed intentionally; external Solana Pay scans skip the on-chain split.
- Modify `Anchor.toml`, `Cargo.toml`, or `scripts/deploy-*.sh` without asking.
- Reference `programId/node_modules` in scripts — it doesn't exist; use `web/node_modules`.
