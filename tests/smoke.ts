import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";

describe("smoke", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  it("loads the program from the workspace", () => {
    const program = (anchor.workspace as any).proofbet;
    assert.ok(program, "anchor.workspace.proofbet should be defined");
    assert.ok(program.programId, "program should have a programId");
  });
});
