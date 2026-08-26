/**
 * The single source of truth for shippable packs. The client renders this
 * list; the worker validates pack-vote ids against it, so a vote for an
 * unknown pack can never win the democratic roll and brick a lobby.
 */
export type PackGroup = "warmup" | "grind";

export type PackDescriptor = {
  packId: string;
  displayName: string;
  blurb: string;
  /** Lobby picker section; new groups render automatically. */
  group: PackGroup;
  puzzlepackUrl: string;
};

export const PACK_MANIFEST: PackDescriptor[] = [
  {
    packId: "warmup",
    displayName: "Warmup",
    blurb: "gentle grids to learn the pace — first solve takes about two minutes",
    group: "warmup",
    puzzlepackUrl: "/puzzles/warmup.puzzlepack.json",
  },
  {
    packId: "sprint",
    displayName: "Sprint",
    blurb: "medium grids where clean scanning beats lucky guessing",
    group: "grind",
    puzzlepackUrl: "/puzzles/sprint.puzzlepack.json",
  },
  {
    packId: "gauntlet",
    displayName: "Gauntlet",
    blurb: "hard and expert grids for long, painful, glorious races",
    group: "grind",
    puzzlepackUrl: "/puzzles/gauntlet.puzzlepack.json",
  },
];

export const PACK_IDS = PACK_MANIFEST.map((pack) => pack.packId);
