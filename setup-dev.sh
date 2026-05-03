#!/bin/bash

# Solana Pay Referral - Development Environment Setup
# This script sets up a complete Solana development environment

set -e

echo "================================"
echo "Solana Dev Environment Setup"
echo "================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_header() {
    echo ""
    echo "================================"
    echo "$1"
    echo "================================"
}

# Step 1: Check prerequisites
print_header "Step 1: Checking Prerequisites"

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

if command_exists node; then
    NODE_VERSION=$(node -v)
    print_success "Node.js installed: $NODE_VERSION"
else
    print_error "Node.js not found. Please install Node.js 18+"
    exit 1
fi

if command_exists yarn; then
    YARN_VERSION=$(yarn -v)
    print_success "Yarn installed: $YARN_VERSION"
else
    print_warning "Yarn not found. Using npm instead"
fi

if command_exists rustc; then
    RUST_VERSION=$(rustc --version)
    print_success "Rust installed: $RUST_VERSION"
else
    print_error "Rust not found. Please install Rust"
    echo "  Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

if command_exists cargo; then
    CARGO_VERSION=$(cargo -v)
    print_success "Cargo installed: $CARGO_VERSION"
else
    print_error "Cargo not found. Please install Rust toolchain"
    exit 1
fi

# Step 2: Install/Update Solana CLI
print_header "Step 2: Installing Solana CLI"

if command_exists solana; then
    SOLANA_VERSION=$(solana --version)
    print_success "Solana CLI already installed: $SOLANA_VERSION"
    read -p "Update Solana CLI? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            brew upgrade solana
        else
            sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
        fi
        print_success "Solana CLI updated"
    fi
else
    echo "Installing Solana CLI..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install solana
    else
        sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
        export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
    fi
    print_success "Solana CLI installed"
fi

# Step 3: Install Solana BPF Tools
print_header "Step 3: Installing Solana BPF Tools"

if command_exists solana-program; then
    print_success "solana-program already installed"
else
    echo "Installing solana-program (this may take a few minutes)..."
    cargo install solana-program
    print_success "solana-program installed"
fi

# Step 4: Configure Solana Network
print_header "Step 4: Configuring Solana Network"

echo "Select network to use:"
echo "1) Devnet (Testing - Recommended)"
echo "2) Mainnet-beta (Production)"
read -p "Enter choice (1-2): " -n 1 -r
echo ""

case $REPLY in
    1)
        solana config set --url devnet
        print_success "Configured for Devnet"
        NETWORK="devnet"
        ;;
    2)
        solana config set --url mainnet-beta
        print_warning "Configured for Mainnet-beta (Production)"
        print_warning "Deployment will cost real SOL!"
        NETWORK="mainnet"
        ;;
    *)
        print_error "Invalid choice"
        exit 1
        ;;
esac

# Step 5: Wallet Setup
print_header "Step 5: Wallet Setup"

if [ -f "$HOME/.config/solana/id.json" ]; then
    WALLET_ADDRESS=$(solana address)
    print_success "Existing wallet found: $WALLET_ADDRESS"
    read -p "Create new wallet? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        solana-keygen new -o ~/.config/solana/id.json
        WALLET_ADDRESS=$(solana address)
        print_success "New wallet created: $WALLET_ADDRESS"
        print_warning "⚠️ SAVE YOUR SEED PHRASE SECURELY!"
    fi
else
    echo "Creating new wallet..."
    solana-keygen new -o ~/.config/solana/id.json
    WALLET_ADDRESS=$(solana address)
    print_success "Wallet created: $WALLET_ADDRESS"
    print_warning "⚠️ SAVE YOUR SEED PHRASE SECURELY!"
    print_warning "Backup location: ~/.config/solana/id.json"
fi

# Step 6: Get SOL for Devnet
if [ "$NETWORK" == "devnet" ]; then
    print_header "Step 6: Getting Devnet SOL"
    
    print_warning "Requesting 2 SOL airdrop from faucet..."
    solana airdrop 2 >/dev/null 2>&1 || solana airdrop 2
    
    sleep 3
    BALANCE=$(solana balance)
    print_success "Balance: $BALANCE"
fi

# Step 7: Install Web Dependencies
print_header "Step 7: Installing Web Dependencies"

if [ -d "web" ]; then
    cd web
    echo "Installing web dependencies..."
    if command_exists yarn; then
        yarn install
    else
        npm install
    fi
    print_success "Web dependencies installed"
    cd ..
else
    print_warning "Web directory not found, skipping"
fi

# Step 8: Build Program
print_header "Step 8: Building Smart Contract"

if [ -d "program" ]; then
    cd program
    echo "Building program (this may take a few minutes)..."
    cargo build-sbf
    print_success "Program built successfully"
    
    # Verify build
    if [ -f "target/deploy/solana_pay_referral.so" ]; then
        SIZE=$(du -h target/deploy/solana_pay_referral.so | cut -f1)
        print_success "Program size: $SIZE"
    fi
    cd ..
else
    print_warning "Program directory not found, skipping"
fi

# Step 9: Create .env file
print_header "Step 9: Creating Environment Files"

if [ ! -f "web/.env.local" ]; then
    cat > web/.env.local << EOF
# Solana Configuration
NEXT_PUBLIC_SOLANA_RPC_URL=$(solana config get | grep "RPC URL" | awk '{print $3}')
NEXT_PUBLIC_SOLANA_NETWORK=$NETWORK

# Program Configuration
# Update this after deployment
NEXT_PUBLIC_PROGRAM_ID=

# USDC Configuration
NEXT_PUBLIC_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
EOF
    print_success "Created web/.env.local"
else
    print_warning "web/.env.local already exists, skipping"
fi

# Step 10: Summary
print_header "Setup Complete!"

echo ""
echo "🎉 Solana development environment is ready!"
echo ""
echo "Your Configuration:"
echo "  Network: $NETWORK"
echo "  Wallet: $WALLET_ADDRESS"
echo ""
echo "Next Steps:"
echo "  1. Read DEBUGGING.md for debugging guide"
echo "  2. Read DEPLOYMENT_GUIDE.md to deploy program"
echo "  3. Run 'yarn test' to run tests"
echo "  4. Run 'cd web && yarn dev' to start dashboard"
echo ""
echo "Useful Commands:"
echo "  solana balance              - Check wallet balance"
echo "  solana logs <PROGRAM_ID>  - View program logs"
echo "  cargo test                  - Run program tests"
echo "  cd web && yarn dev         - Start dashboard"
echo ""

if [ "$NETWORK" == "devnet" ]; then
    print_success "✓ You're on Devnet (safe for testing)"
else
    print_warning "⚠️ You're on Mainnet (real money!)"
fi

echo "================================"
