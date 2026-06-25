// Glob re-exports are required: Anchor's `#[program]` macro resolves the
// generated `__client_accounts_*` / `__cpi_client_accounts_*` modules through
// `crate::instructions::*`. Each instruction module also defines a `handler`,
// so the globs collide on that name — harmless here (lib.rs always calls the
// fully-qualified `instructions::<name>::handler`), so we silence the lint.
#![allow(ambiguous_glob_reexports)]

pub mod initialize_market;
pub use initialize_market::*;

pub mod place_bet;
pub use place_bet::*;
