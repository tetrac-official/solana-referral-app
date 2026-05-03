#!/usr/bin/env bash
set -euo pipefail

# Deploy the Solana Pay Referral program to devnet and optionally airdrop SOL.
# Usage:
#   ./scripts/deploy-devnet.sh          # build + deploy
#   ./scripts/deploy-devnet.sh --airdrop # also request 2 SOL airdrop first

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROGRAM_DIR="$PROJECT_DIR/programId"
PROGRAM_ID="DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3"
KEYPAIR="$PROGRAM_DIR/target/deploy/program-keypair.json"

echo "==> Switching Solana CLI to devnet"
solana config set --url devnet

WALLET=$(solana address)
echo "==> Deployer wallet: $WALLET"
echo "==> Program ID:      $PROGRAM_ID"

# Optional airdrop
if [[ "${1:-}" == "--airdrop" ]]; then
  echo "==> Requesting 2 SOL airdrop on devnet..."
  solana airdrop 2 "$WALLET" --url devnet || echo "    (airdrop may be rate-limited — check balance manually)"
fi

BALANCE=$(solana balance --url devnet | awk '{print $1}')
echo "==> Wallet balance:  $BALANCE SOL"

# Build
echo "==> Building program with cargo build-sbf..."
cd "$PROGRAM_DIR"
cargo build-sbf

# Check if program already exists on devnet
echo "==> Checking if program is already deployed..."
if solana program show "$PROGRAM_ID" --url devnet 2>/dev/null | grep -q "Program Id"; then
  echo "    Program exists — this will be an upgrade."
else
  echo "    Program not found — this will be a fresh deploy (~2-3 SOL)."
fi

# Deploy
echo "==> Deploying to devnet..."
solana program deploy \
  target/deploy/program.so \
  --program-id "$KEYPAIR" \
  --url devnet

echo ""
echo "==> Deployed! Verify with:"
echo "    solana program show $PROGRAM_ID --url devnet"
echo ""
echo "==> Next steps:"
echo "    1. Start the web client:  cd web && yarn dev"
echo "    2. Toggle to Devnet in the UI header"
echo "    3. Enter program ID: $PROGRAM_ID"
echo "    4. Select SOL token, set a small amount (0.01 SOL)"
echo "    5. Connect wallet and click 'Process Payment'"
echo ""
echo "    For USDC testing later, click 'Initialize USDC Vault' first."
