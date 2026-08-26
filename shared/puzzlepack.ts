export type Difficulty = "easy" | "medium" | "hard" | "expert";

/**
 * One sudoku. Grids are 81-character strings in row-major order, digits
 * `1`-`9`, `.` for an empty cell — compact, diffable, and trivially indexable
 * (cell i = row Math.floor(i/9), col i%9).
 */
export type Puzzle = {
  /** Unique within the pack; stable across versions (sessions reference it). */
  id: string;
  difficulty: Difficulty;
  /** The puzzle as players see it: givens plus blanks. */
  givens: string;
  /** The unique solution; clients check placements against it locally. */
  solution: string;
};

export type PackSource = {
  name: string;
  license: string;
};

export type PuzzlePack = {
  /** Lowercase kebab-case, immutable once shipped (rooms reference it). */
  packId: string;
  displayName: string;
  source: PackSource;
  puzzles: Puzzle[];
};
