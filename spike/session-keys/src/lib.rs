use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;
// The macros come from session-keys (re-exported under `no-entrypoint`):
//   #[derive(Session)]  — impls the Session trait on the accounts struct
//   #[session_auth_or]  — gates a handler on (session token valid) OR (auth expr)
use session_keys::{session_auth_or, Session, SessionError, SessionToken};

// SLICE-6 spike: does `#[session_auth_or(...)]` on an ER instruction build under
// anchor-lang 0.32.1 + ephemeral-rollups-sdk 0.14.4 (anchor-compat)? This mirrors
// the real integration surface: a `lock_pick`-shaped instruction that a session
// key may sign popup-free on behalf of `entry.player`, inside an #[ephemeral]
// program. If green → no anchor-1.0 migration needed for session keys.

// Reuse the live-er spike's valid program id (any real 32-byte pubkey works).
declare_id!("HQfjhrpFSbRp1XRVSkMecMFEesh3k3vrab9HkRWSLdV2");

pub const MAX_CALLS: usize = 6;

#[ephemeral]
#[program]
pub mod session_keys_spike {
    use super::*;

    // Minimal `lock_pick` clone. The ONLY new thing vs the real handler is the
    // `#[session_auth_or(...)]` gate: EITHER a valid SessionToken (whose
    // authority == entry.player) signed, OR the real player signed. `ctx` is the
    // identifier the macro hardcodes; `SessionError` must be in scope (the macro
    // emits `SessionError::InvalidToken`).
    #[session_auth_or(
        ctx.accounts.entry.player == ctx.accounts.signer.key(),
        ProofBetError::Unauthorized
    )]
    pub fn lock_pick(ctx: Context<LockPick>, seq: u8, option: u8) -> Result<()> {
        let entry = &mut ctx.accounts.entry;
        require!((seq as usize) < MAX_CALLS, ProofBetError::CallLimitReached);
        entry.picks[seq as usize] = option;
        Ok(())
    }
}

// Mirrors the real LiveEntry seat (player + picks array).
#[account]
pub struct LiveEntry {
    pub player: Pubkey,
    pub bump: u8,
    pub picks: [u8; MAX_CALLS],
}

impl LiveEntry {
    pub const LEN: usize = 8 + 32 + 1 + MAX_CALLS;
}

// `#[derive(Session)]` needs a field named `session_token` of type
// `Option<Account<'info, SessionToken>>` carrying `#[session(signer=..., authority=..)]`.
// The `signer` is the ephemeral session key that actually signs; the `authority`
// is the human wallet that owns the seat — for lock_pick that's `entry.player`.
#[derive(Accounts, Session)]
#[instruction(seq: u8, option: u8)]
pub struct LockPick<'info> {
    // The tap signer. In the session path this is the ephemeral session keypair;
    // in the fallback path it's the real player. Either way it must sign.
    pub signer: Signer<'info>,

    #[session(
        // the session key that is authorized to sign for this seat
        signer = signer,
        // the human wallet that owns the seat == entry.player
        authority = entry.player.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,

    #[account(
        mut,
        seeds = [b"liveentry", entry.player.as_ref()],
        bump = entry.bump,
    )]
    pub entry: Account<'info, LiveEntry>,
}

#[error_code]
pub enum ProofBetError {
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("call limit reached")]
    CallLimitReached,
}
