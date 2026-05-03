#!/usr/bin/env bash
set -euo pipefail

# Deploy the Solana Pay Referral program to mainnet-beta.
# Usage:
#   ./scripts/deploy-mainnet.sh          # build + deploy

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROGRAM_DIR="$PROJECT_DIR/programId"
PROGRAM_ID="DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3"
KEYPAIR="$PROGRAM_DIR/target/deploy/program-keypair.json"

echo "============================================"
echo "  MAINNET DEPLOYMENT — Solana Pay Referral"
echo "============================================"
echo ""

echo "==> Switching Solana CLI to mainnet-beta"
solana config set --url mainnet-beta

WALLET=$(solana address)
echo "==> Deployer wallet: $WALLET"
echo "==> Program ID:      $PROGRAM_ID"

BALANCE=$(solana balance --url mainnet-beta | awk '{print $1}')
echo "==> Wallet balance:  $BALANCE SOL"

# Safety check: warn if balance is low
MIN_BALANCE=3
if (( $(echo "$BALANCE < $MIN_BALANCE" | bc -l) )); then
  echo ""
  echo "WARNING: Balance is below $MIN_BALANCE SOL."
  echo "         A fresh deploy costs ~2-3 SOL; an upgrade costs ~0.5 SOL."
  echo "         Fund your wallet before proceeding."
  echo ""
fi

# Confirmation prompt — mainnet deploys cost real SOL
echo ""
echo "You are about to deploy to MAINNET (real money)."
read -p "Type 'yes' to confirm: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

# Build
echo ""
echo "==> Building program with cargo build-sbf..."
cd "$PROGRAM_DIR"
cargo build-sbf

# Check if program already exists on mainnet
echo "==> Checking if program is already deployed..."
if solana program show "$PROGRAM_ID" --url mainnet-beta 2>/dev/null | grep -q "Program Id"; then
  echo "    Program exists — this will be an upgrade."
else
  echo "    Program not found — this will be a fresh deploy (~2-3 SOL)."
fi

# Deploy
echo "==> Deploying to mainnet-beta..."
solana program deploy \
  target/deploy/program.so \
  --program-id "$KEYPAIR" \
  --url mainnet-beta

echo ""
echo "==> Deployed! Verify with:"
echo "    solana program show $PROGRAM_ID --url mainnet-beta"
echo ""
echo "==> Next steps:"
echo "    1. Start the web client:  cd web && yarn dev"
echo "    2. Toggle to Mainnet in the UI header"
echo "    3. Enter program ID: $PROGRAM_ID"
echo "    4. Test with a small SOL payment (0.01 SOL)"
echo ""
echo "    For USDC: click 'Initialize USDC Vault' first, then test a small USDC split."
