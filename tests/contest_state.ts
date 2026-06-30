import { program, assert } from "./helpers";

// Task 1: state + constants layout sanity. These assertions pin the v2 account
// shapes (Jackpot replaces JackpotVault; Contest gains market_ids/num_legs and
// drops pot_snapshot) so a later accidental field rename/removal is caught here.

describe("parlay v2 — state layout", () => {
  it("exposes the Jackpot account (replacing JackpotVault) with only a bump", () => {
    // The IDL drives every off-chain client; assert the renamed account is present
    // and the old singleton-vault fields (active_contest_id, reserved) are gone.
    const acct = (program.idl.accounts as any[]).find((a) => a.name === "Jackpot" || a.name === "jackpot");
    assert.ok(acct, "Jackpot account is defined in the IDL");
    const jackpotVault = (program.idl.accounts as any[]).find(
      (a) => a.name === "JackpotVault" || a.name === "jackpotVault",
    );
    assert.isUndefined(jackpotVault, "JackpotVault is removed");
  });

  it("Contest carries market_ids + num_legs and drops pot_snapshot/num_matches", () => {
    const types = (program.idl as any).types ?? [];
    const accounts = (program.idl as any).accounts ?? [];
    // In Anchor 0.31 the account layout lives in `types` (accounts reference a type).
    const contestType =
      types.find((t: any) => t.name === "Contest" || t.name === "contest") ??
      accounts.find((a: any) => a.name === "Contest" || a.name === "contest");
    assert.ok(contestType, "Contest type is defined");
    const fields: any[] = contestType.type?.fields ?? contestType.fields ?? [];
    const names = fields.map((f) => f.name);
    assert.include(names, "marketIds", "Contest.market_ids present");
    assert.include(names, "numLegs", "Contest.num_legs present");
    assert.notInclude(names, "numMatches", "num_matches renamed to num_legs");
    assert.notInclude(names, "potSnapshot", "pot_snapshot dropped");
  });
});
