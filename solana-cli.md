```bash
solana balance --url devnet
solana airdrop 2 --url devnet         # free; may be rate-limited
# if rate-limited, try smaller amounts:
solana airdrop 1 --url devnet
solana airdrop 1 --url devnet
# or use the web faucet: https://faucet.solana.com
```

# devnet deploy 
```bash
# 1. Switch CLI to the file keypair (existing devnet program's upgrade authority):
solana config set --keypair ~/.config/solana/id.json --url devnet
solana address           # must print BYNtxb7zMereaMrmMcWCQx3G6Y1KZspnMJbiuqoh9MrF

# 2. Build with the devnet-admin feature:
cd programId
cargo build-sbf --features devnet-admin

# 3. Upgrade the existing devnet program (fits in existing allocation — new binary is smaller):
solana program deploy \
  target/deploy/program.so \
  --program-id target/deploy/program-keypair.json \
  --url devnet

# 4. Run all 31 integration tests with the devnet admin override:
cd ..
ADMIN_PUBKEY=BYNtxb7zMereaMrmMcWCQx3G6Y1KZspnMJbiuqoh9MrF node scripts/test-suite.cjs
```