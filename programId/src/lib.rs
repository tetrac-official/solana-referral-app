use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

declare_id!("DiAruQom5HzAzBYJER9jPUX6fqzKPdiwQ9v1g27nNzD3");

const TOKEN_AUTHORITY_SEED: &[u8] = b"token_authority";
const REFERENCE_SEED: &[u8] = b"reference";
const AFFILIATE_SEED: &[u8] = b"affiliate";
const BPS_DENOMINATOR: u64 = 10_000;
const DEFAULT_COMMISSION_BPS: u16 = 500; // 5% — Starter tier
const MAX_COMMISSION_BPS: u16 = 2000; // 20% cap
const MIN_SOL_LAMPORTS: u64 = 1_000;
const MIN_USDC_AMOUNT: u64 = 1_000;
const AUTO_PROMOTE_REFERRALS: u32 = 10; // Starter → Silver at 10 referrals

/// Admin key — upgrade authority, gates promote + sweep.
/// 2v4XjdTjHK7qKEc8BkCeCWFrZmGSJv32ZGyv27zw3jc5 (Ledger)
const ADMIN: Pubkey = Pubkey::new_from_array([
    28, 115, 118, 10, 50, 227, 159, 108,
    57, 25, 152, 172, 33, 197, 185, 225,
    100, 128, 212, 52, 209, 59, 192, 105,
    27, 84, 165, 148, 199, 229, 215, 42,
]);

#[program]
pub mod referral {
    use super::*;

    /// One-time: create the global USDC vault ATA.
    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        msg!("Vault initialized");
        Ok(())
    }

    /// Self-register as an affiliate at the Starter tier (5%).
    /// Affiliate pays rent (~0.002 SOL). No admin needed.
    pub fn register_affiliate(ctx: Context<RegisterAffiliate>) -> Result<()> {
        let clock = Clock::get()?;
        ctx.accounts.affiliate_config.set_inner(AffiliateConfig {
            affiliate: ctx.accounts.affiliate.key(),
            commission_bps: DEFAULT_COMMISSION_BPS,
            tier: 0,
            total_referrals: 0,
            total_volume: 0,
            created_at: clock.unix_timestamp,
            updated_at: clock.unix_timestamp,
        });
        msg!(
            "Affiliate registered: {} at {}bps",
            ctx.accounts.affiliate.key(),
            DEFAULT_COMMISSION_BPS
        );
        Ok(())
    }

    /// Admin-only: change an affiliate's tier and commission rate.
    pub fn promote_affiliate(
        ctx: Context<PromoteAffiliate>,
        new_tier: u8,
        new_bps: u16,
    ) -> Result<()> {
        require!(ctx.accounts.admin.key() == ADMIN, ErrorCode::Unauthorized);
        require!(new_bps <= MAX_COMMISSION_BPS, ErrorCode::CommissionTooHigh);

        let config = &mut ctx.accounts.affiliate_config;
        config.tier = new_tier;
        config.commission_bps = new_bps;
        config.updated_at = Clock::get()?.unix_timestamp;

        msg!(
            "Affiliate promoted: {} → tier {} at {}bps",
            config.affiliate,
            new_tier,
            new_bps
        );
        Ok(())
    }

    /// Atomic USDC split: vault → merchant (100 - x%) + affiliate (x%).
    /// Commission read from affiliate's AffiliateConfig PDA.
    pub fn receive_and_split(
        ctx: Context<ReceiveAndSplit>,
        memo_data: String,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(amount >= MIN_USDC_AMOUNT, ErrorCode::AmountBelowMinimum);

        let (merchant_pubkey, affiliate_pubkey) = parse_and_validate_memo(&memo_data)?;

        require!(
            ctx.accounts.merchant_token_account.owner == merchant_pubkey,
            ErrorCode::MerchantMismatch
        );

        // Validate affiliate account + config pairing
        match (
            ctx.accounts.affiliate_token_account.as_ref(),
            ctx.accounts.affiliate_config.as_mut(),
            affiliate_pubkey,
        ) {
            (Some(aff_acct), Some(aff_cfg), Some(aff_key)) => {
                require!(aff_acct.owner == aff_key, ErrorCode::AffiliateMismatch);
                require!(aff_cfg.affiliate == aff_key, ErrorCode::AffiliateMismatch);
                // Verify PDA derivation
                let (expected_pda, _) = Pubkey::find_program_address(
                    &[AFFILIATE_SEED, aff_key.as_ref()],
                    ctx.program_id,
                );
                require!(
                    aff_cfg.key() == expected_pda,
                    ErrorCode::AffiliateMismatch
                );
            }
            (None, None, None) => {}
            _ => return Err(ErrorCode::AffiliateMismatch.into()),
        }

        let (affiliate_amount, merchant_amount, commission_bps) =
            if let (Some(aff_cfg), Some(_aff_key)) =
                (ctx.accounts.affiliate_config.as_mut(), affiliate_pubkey)
            {
                let bps = aff_cfg.commission_bps as u64;
                let aff = amount
                    .checked_mul(bps)
                    .and_then(|v| v.checked_div(BPS_DENOMINATOR))
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
                let mer = amount.checked_sub(aff).ok_or(ErrorCode::ArithmeticOverflow)?;

                // Update lifetime stats
                aff_cfg.total_referrals = aff_cfg
                    .total_referrals
                    .checked_add(1)
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
                aff_cfg.total_volume = aff_cfg
                    .total_volume
                    .checked_add(amount)
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
                aff_cfg.updated_at = Clock::get()?.unix_timestamp;

                // Auto-promote: Starter → Silver at threshold
                if aff_cfg.tier == 0 && aff_cfg.total_referrals >= AUTO_PROMOTE_REFERRALS {
                    aff_cfg.tier = 1;
                    aff_cfg.commission_bps = 1000; // 10%
                    msg!("Auto-promoted affiliate to Silver (10%)");
                }

                (aff, mer, bps)
            } else {
                (0u64, amount, 0u64)
            };

        msg!(
            "USDC split — total: {}, merchant: {}, affiliate: {} ({}bps)",
            amount,
            merchant_amount,
            affiliate_amount,
            commission_bps
        );

        let clock = Clock::get()?;
        ctx.accounts.reference_storage.set_inner(ReferenceStorage {
            merchant_pubkey: merchant_pubkey.to_bytes(),
            affiliate_pubkey: affiliate_pubkey.map(|p| p.to_bytes()),
            amount,
            timestamp: clock.unix_timestamp,
            reference: ctx.accounts.reference.key().to_bytes(),
        });

        let bump = ctx.bumps.token_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[TOKEN_AUTHORITY_SEED, &[bump]]];

        if affiliate_amount > 0 {
            let affiliate_account = ctx
                .accounts
                .affiliate_token_account
                .as_ref()
                .ok_or(ErrorCode::AffiliateMismatch)?;

            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.program_token_account.to_account_info(),
                    to: affiliate_account.to_account_info(),
                    authority: ctx.accounts.token_authority.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(cpi_ctx, affiliate_amount)?;
        }

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.program_token_account.to_account_info(),
                to: ctx.accounts.merchant_token_account.to_account_info(),
                authority: ctx.accounts.token_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, merchant_amount)?;

        Ok(())
    }

    /// Atomic SOL split: PDA → merchant (100 - x%) + affiliate (x%).
    /// Commission read from affiliate's AffiliateConfig PDA.
    pub fn receive_and_split_sol(
        ctx: Context<ReceiveAndSplitSol>,
        memo_data: String,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(amount >= MIN_SOL_LAMPORTS, ErrorCode::AmountBelowMinimum);

        let (merchant_pubkey, affiliate_pubkey) = parse_and_validate_memo(&memo_data)?;

        require!(
            ctx.accounts.merchant.key() == merchant_pubkey,
            ErrorCode::MerchantMismatch
        );

        // Validate affiliate account + config pairing
        match (
            ctx.accounts.affiliate.as_ref(),
            ctx.accounts.affiliate_config.as_mut(),
            affiliate_pubkey,
        ) {
            (Some(aff_acct), Some(aff_cfg), Some(aff_key)) => {
                require!(aff_acct.key() == aff_key, ErrorCode::AffiliateMismatch);
                require!(aff_cfg.affiliate == aff_key, ErrorCode::AffiliateMismatch);
                let (expected_pda, _) = Pubkey::find_program_address(
                    &[AFFILIATE_SEED, aff_key.as_ref()],
                    ctx.program_id,
                );
                require!(
                    aff_cfg.key() == expected_pda,
                    ErrorCode::AffiliateMismatch
                );
            }
            (None, None, None) => {}
            _ => return Err(ErrorCode::AffiliateMismatch.into()),
        }

        let (affiliate_amount, merchant_amount, commission_bps) =
            if let (Some(aff_cfg), Some(_aff_key)) =
                (ctx.accounts.affiliate_config.as_mut(), affiliate_pubkey)
            {
                let bps = aff_cfg.commission_bps as u64;
                let aff = amount
                    .checked_mul(bps)
                    .and_then(|v| v.checked_div(BPS_DENOMINATOR))
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
                let mer = amount.checked_sub(aff).ok_or(ErrorCode::ArithmeticOverflow)?;

                // Update lifetime stats
                aff_cfg.total_referrals = aff_cfg
                    .total_referrals
                    .checked_add(1)
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
                aff_cfg.total_volume = aff_cfg
                    .total_volume
                    .checked_add(amount)
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
                aff_cfg.updated_at = Clock::get()?.unix_timestamp;

                // Auto-promote: Starter → Silver
                if aff_cfg.tier == 0 && aff_cfg.total_referrals >= AUTO_PROMOTE_REFERRALS {
                    aff_cfg.tier = 1;
                    aff_cfg.commission_bps = 1000;
                    msg!("Auto-promoted affiliate to Silver (10%)");
                }

                (aff, mer, bps)
            } else {
                (0u64, amount, 0u64)
            };

        msg!(
            "SOL split — total: {}, merchant: {}, affiliate: {} ({}bps)",
            amount,
            merchant_amount,
            affiliate_amount,
            commission_bps
        );

        let clock = Clock::get()?;
        ctx.accounts.reference_storage.set_inner(ReferenceStorage {
            merchant_pubkey: merchant_pubkey.to_bytes(),
            affiliate_pubkey: affiliate_pubkey.map(|p| p.to_bytes()),
            amount,
            timestamp: clock.unix_timestamp,
            reference: ctx.accounts.reference.key().to_bytes(),
        });

        let bump = ctx.bumps.token_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[TOKEN_AUTHORITY_SEED, &[bump]]];

        if affiliate_amount > 0 {
            let affiliate = ctx
                .accounts
                .affiliate
                .as_ref()
                .ok_or(ErrorCode::AffiliateMismatch)?;

            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.token_authority.to_account_info(),
                        to: affiliate.to_account_info(),
                    },
                    signer_seeds,
                ),
                affiliate_amount,
            )?;
        }

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.token_authority.to_account_info(),
                    to: ctx.accounts.merchant.to_account_info(),
                },
                signer_seeds,
            ),
            merchant_amount,
        )?;

        Ok(())
    }

    /// Admin-only: drain all USDC from the vault to a destination ATA.
    pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
        require!(ctx.accounts.admin.key() == ADMIN, ErrorCode::Unauthorized);

        let vault_balance = ctx.accounts.program_token_account.amount;
        require!(vault_balance > 0, ErrorCode::InvalidAmount);

        msg!("Sweep USDC — amount: {}", vault_balance);

        let bump = ctx.bumps.token_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[TOKEN_AUTHORITY_SEED, &[bump]]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.program_token_account.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.token_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, vault_balance)?;

        Ok(())
    }

    /// Admin-only: drain excess SOL from the PDA to a destination wallet.
    pub fn sweep_sol(ctx: Context<SweepSol>) -> Result<()> {
        require!(ctx.accounts.admin.key() == ADMIN, ErrorCode::Unauthorized);

        let pda_balance = ctx.accounts.token_authority.lamports();
        let rent = Rent::get()?.minimum_balance(0);
        let available = pda_balance.saturating_sub(rent);
        require!(available > 0, ErrorCode::InvalidAmount);

        msg!("Sweep SOL — amount: {}", available);

        let bump = ctx.bumps.token_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[TOKEN_AUTHORITY_SEED, &[bump]]];

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.token_authority.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                },
                signer_seeds,
            ),
            available,
        )?;

        Ok(())
    }
}

// ── Account contexts ──────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Global PDA that owns the vault
    #[account(seeds = [TOKEN_AUTHORITY_SEED], bump)]
    pub token_authority: UncheckedAccount<'info>,

    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = token_authority,
    )]
    pub program_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAffiliate<'info> {
    #[account(mut)]
    pub affiliate: Signer<'info>,

    #[account(
        init,
        payer = affiliate,
        space = AffiliateConfig::SPACE,
        seeds = [AFFILIATE_SEED, affiliate.key().as_ref()],
        bump,
    )]
    pub affiliate_config: Account<'info, AffiliateConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PromoteAffiliate<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut)]
    pub affiliate_config: Account<'info, AffiliateConfig>,
}

#[derive(Accounts)]
pub struct ReceiveAndSplit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Global PDA that signs vault transfers
    #[account(seeds = [TOKEN_AUTHORITY_SEED], bump)]
    pub token_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = token_authority,
    )]
    pub program_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub merchant_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub affiliate_token_account: Option<Account<'info, TokenAccount>>,

    /// Affiliate config PDA — optional, required when affiliate is present
    #[account(mut)]
    pub affiliate_config: Option<Account<'info, AffiliateConfig>>,

    pub usdc_mint: Account<'info, Mint>,

    /// CHECK: Solana Pay reference key — used as PDA seed for uniqueness
    pub reference: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = ReferenceStorage::SPACE,
        seeds = [REFERENCE_SEED, reference.key().as_ref()],
        bump
    )]
    pub reference_storage: Account<'info, ReferenceStorage>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReceiveAndSplitSol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Global PDA — temporarily holds SOL between transfer-in and split-out
    #[account(mut, seeds = [TOKEN_AUTHORITY_SEED], bump)]
    pub token_authority: UncheckedAccount<'info>,

    /// CHECK: Merchant wallet — receives SOL directly
    #[account(mut)]
    pub merchant: UncheckedAccount<'info>,

    /// CHECK: Affiliate wallet — receives SOL directly (optional)
    #[account(mut)]
    pub affiliate: Option<UncheckedAccount<'info>>,

    /// Affiliate config PDA — optional, required when affiliate is present
    #[account(mut)]
    pub affiliate_config: Option<Account<'info, AffiliateConfig>>,

    /// CHECK: Solana Pay reference key — used as PDA seed for uniqueness
    pub reference: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = ReferenceStorage::SPACE,
        seeds = [REFERENCE_SEED, reference.key().as_ref()],
        bump
    )]
    pub reference_storage: Account<'info, ReferenceStorage>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Global PDA that owns the vault
    #[account(seeds = [TOKEN_AUTHORITY_SEED], bump)]
    pub token_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = token_authority,
    )]
    pub program_token_account: Account<'info, TokenAccount>,

    /// Destination ATA to receive swept USDC
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SweepSol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Global PDA — holds SOL to be swept
    #[account(mut, seeds = [TOKEN_AUTHORITY_SEED], bump)]
    pub token_authority: UncheckedAccount<'info>,

    /// CHECK: Destination wallet to receive swept SOL
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ── Data accounts ─────────────────────────────────────────────────────

#[account]
pub struct AffiliateConfig {
    pub affiliate: Pubkey,      // 32 — affiliate wallet
    pub commission_bps: u16,    // 2  — basis points (500 = 5%)
    pub tier: u8,               // 1  — 0=Starter, 1=Silver, 2=Gold
    pub total_referrals: u32,   // 4  — lifetime count
    pub total_volume: u64,      // 8  — lifetime raw amount units
    pub created_at: i64,        // 8
    pub updated_at: i64,        // 8
}

impl AffiliateConfig {
    // 8 (discriminator) + 32 + 2 + 1 + 4 + 8 + 8 + 8 = 71
    pub const SPACE: usize = 8 + 32 + 2 + 1 + 4 + 8 + 8 + 8;
}

#[account]
pub struct ReferenceStorage {
    pub merchant_pubkey: [u8; 32],
    pub affiliate_pubkey: Option<[u8; 32]>,
    pub amount: u64,
    pub timestamp: i64,
    pub reference: [u8; 32],
}

impl ReferenceStorage {
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 8 + 8 + 32;
}

// ── Errors ────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Arithmetic overflow occurred")]
    ArithmeticOverflow,
    #[msg("Invalid memo format: not valid JSON")]
    InvalidMemoFormat,
    #[msg("Missing merchant_id in memo")]
    MissingMerchantId,
    #[msg("Invalid merchant pubkey in memo")]
    InvalidMerchantPubkey,
    #[msg("Invalid affiliate pubkey in memo")]
    InvalidAffiliatePubkey,
    #[msg("Merchant token account owner does not match memo merchant_id")]
    MerchantMismatch,
    #[msg("Affiliate token account presence/owner does not match memo")]
    AffiliateMismatch,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Amount is below the minimum threshold")]
    AmountBelowMinimum,
    #[msg("Only the admin can perform this action")]
    Unauthorized,
    #[msg("Commission cannot exceed 2000 bps (20%)")]
    CommissionTooHigh,
}

// ── Memo parser ───────────────────────────────────────────────────────

fn parse_and_validate_memo(memo: &str) -> Result<(Pubkey, Option<Pubkey>)> {
    let memo = memo.trim();

    if !memo.starts_with('{') || !memo.ends_with('}') {
        return Err(ErrorCode::InvalidMemoFormat.into());
    }

    let content = &memo[1..memo.len() - 1];

    let mut merchant_id: Option<&str> = None;
    let mut affiliate_id: Option<&str> = None;

    for pair in content.split(',') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let colon = pair
            .find(':')
            .ok_or_else(|| error!(ErrorCode::InvalidMemoFormat))?;
        let raw_key = pair[..colon].trim();
        let raw_value = pair[colon + 1..].trim();

        let key = strip_quotes(raw_key).ok_or(ErrorCode::InvalidMemoFormat)?;
        let value = strip_quotes(raw_value).ok_or(ErrorCode::InvalidMemoFormat)?;

        if value.contains(',') || value.contains(':') || value.contains('"') {
            return Err(ErrorCode::InvalidMemoFormat.into());
        }

        match key {
            "merchant_id" => merchant_id = Some(value),
            "affiliate_id" => affiliate_id = Some(value),
            _ => {}
        }
    }

    let merchant_str = merchant_id.ok_or(ErrorCode::MissingMerchantId)?;
    let merchant_pubkey = merchant_str
        .parse::<Pubkey>()
        .map_err(|_| error!(ErrorCode::InvalidMerchantPubkey))?;

    let affiliate_pubkey = match affiliate_id {
        Some(s) => Some(
            s.parse::<Pubkey>()
                .map_err(|_| error!(ErrorCode::InvalidAffiliatePubkey))?,
        ),
        None => None,
    };

    Ok((merchant_pubkey, affiliate_pubkey))
}

fn strip_quotes(s: &str) -> Option<&str> {
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        Some(&s[1..s.len() - 1])
    } else {
        None
    }
}
