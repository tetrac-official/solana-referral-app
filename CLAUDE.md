# CLAUDE.md

Solana Pay Referral — atomic SOL/USDC splitter with tiered affiliate commissions (5/10/15%).

## Deployed (devnet)
- Program: `DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3`
- Admin / upgrade authority: `2v4XjdTjHK7qKEc8BkCeCWFrZmGSJv32ZGyv27zw3jc5` (Ledger)

## Build & deploy
- Build: `cd programId && cargo build-sbf`. Full prereqs + toolchain troubleshooting in [solana-build.md](solana-build.md).
- Deploy: [scripts/deploy-devnet.sh](scripts/deploy-devnet.sh), [scripts/deploy-mainnet.sh](scripts/deploy-mainnet.sh). Mainnet checklist in [mainnet-deploy.md](mainnet-deploy.md).
- Ledger is the upgrade authority on devnet (will be on mainnet too). Before any deploy: `solana config set --keypair usb://ledger`, enable **blind signing** in the Solana app on the device, expect ~30+ confirmation prompts per fresh deploy. Use the buffer flow (`solana program write-buffer` → `solana program deploy --buffer`) for resilience if the cable disconnects.

## Solana 3.x toolchain quirk (READ before first build on a new machine)
- Symptom: `cargo build-sbf` fails with `custom toolchain '1.89.0-sbpf-solana-v1.52' ... is not installed` even though `solana --version` is 3.x and `cargo-build-sbf --version` reports `platform-tools v1.52`.
- Cause: Solana 3.x installer registers `~/.rustup/toolchains/1.89.0-sbpf-solana-v1.52` as a symlink to a path that doesn't exist — platform-tools is never actually downloaded. `cargo metadata` (invoked by `cargo build-sbf` before the install step) trips on `programId/rust-toolchain.toml` and aborts before bootstrap can run.
- Fix (one-time per machine):
  ```bash
  cd programId
  mv rust-toolchain.toml rust-toolchain.toml.bak
  rustup toolchain uninstall 1.89.0-sbpf-solana-v1.52   # remove dead symlink
  cargo-build-sbf --force-tools-install                  # downloads platform-tools (~200 MB)
  mv rust-toolchain.toml.bak rust-toolchain.toml
  cargo build-sbf                                        # real build
  ```
- `--force-tools-install` alone does **not** work — the override-move is mandatory because `cargo metadata` runs first.

## Admin rotation
- `ADMIN` is a hardcoded `Pubkey` const at [programId/src/lib.rs:19-24](programId/src/lib.rs#L19-L24) (raw 32-byte array). There is no on-chain admin config — rotation requires editing the byte array and redeploying.
- When changing admin: also update [scripts/test-suite.cjs:46](scripts/test-suite.cjs#L46), [README.md](README.md), [mainnet-deploy.md](mainnet-deploy.md), and this file. Otherwise tests + docs lie about the active admin.
- Decode a base58 pubkey → byte array with stdlib Python (no `@solana/web3.js` needed, since `web/node_modules` may not be installed):
  ```bash
  python3 <<'PY'
  ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  s = '<PUBKEY>'
  n = 0
  for c in s: n = n * 58 + ALPHA.index(c)
  print(list(n.to_bytes(32, 'big')))
  PY
  ```

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
