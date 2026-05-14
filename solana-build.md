# Solana Build

## Check versions
```bash
rustc --version
cargo --version
solana --version
cargo-build-sbf --version
anchor --version
```

## Install (skip any already installed)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.32.1
avm use 0.32.1
```

## Bootstrap platform-tools (first build on a new machine)
```bash
cd programId
mv rust-toolchain.toml rust-toolchain.toml.bak
rustup toolchain uninstall 1.89.0-sbpf-solana-v1.52
cargo-build-sbf --force-tools-install
mv rust-toolchain.toml.bak rust-toolchain.toml
```

## Build
```bash
cd programId
cargo build-sbf
```

## Verify
```bash
solana-keygen pubkey programId/target/deploy/program-keypair.json
grep declare_id programId/src/lib.rs
file programId/target/deploy/program.so
```

## Regenerate IDL
```bash
cd programId
anchor build
cp target/idl/program.json ../web/idl/program.json
```

## Clean rebuild
```bash
cd programId
cargo clean
cargo build-sbf
```

Deploy with Ledger: see [mainnet-deploy.md](mainnet-deploy.md).
