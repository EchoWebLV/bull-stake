export interface Frame {
  tMs: number; minute: number; phase: string;
  scoreH: number; scoreA: number; corners1: number; corners2: number;
}
export interface Replay {
  fixtureId: number; home: string; away: string; frames: Frame[];
}
export interface MatchState {
  fixtureId: number; home: string; away: string;
  minute: number; phase: string; scoreH: number; scoreA: number;
  corners1: number; corners2: number; totalCorners: number; isFinal: boolean;
}

const FINAL_PHASES = new Set(["F", "FET", "FPE"]);

/** Replays a captured corners timeline against wall-clock for a deterministic demo. */
export class Feed {
  private startedAt = 0;
  constructor(private replay: Replay, private now: () => number = () => Date.now()) {}

  start(at = this.now()): void { this.startedAt = at; }

  private frameAt(elapsedMs: number): Frame {
    const { frames } = this.replay;
    let chosen = frames[0];
    for (const fr of frames) { if (fr.tMs <= elapsedMs) chosen = fr; else break; }
    return chosen;
  }

  current(): MatchState {
    const fr = this.frameAt(this.now() - this.startedAt);
    return {
      fixtureId: this.replay.fixtureId, home: this.replay.home, away: this.replay.away,
      minute: fr.minute, phase: fr.phase, scoreH: fr.scoreH, scoreA: fr.scoreA,
      corners1: fr.corners1, corners2: fr.corners2,
      totalCorners: fr.corners1 + fr.corners2, isFinal: FINAL_PHASES.has(fr.phase),
    };
  }
}
