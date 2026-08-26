/**
 * Sudoku engine: generation, hole-digging with a uniqueness guarantee, and
 * validation helpers. Pure functions on plain arrays — no I/O, no clock — so
 * the authoritative relay rules stay unit-testable without a runtime.
 *
 * Grids are 81-cell row-major arrays; 0 means empty. The string form used on
 * the wire (`shared/puzzlepack` heritage) is digits 1-9 with `.` for blanks.
 */

export type Grid = number[]; // length 81, values 0-9
export type Difficulty = "easy" | "medium" | "hard";

/** Givens kept per difficulty. Fewer givens = harder and slower to generate. */
export const DIFFICULTY_GIVENS: Record<Difficulty, number> = {
  easy: 40,
  medium: 32,
  hard: 26,
};

export const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === "string" && (DIFFICULTIES as readonly string[]).includes(value);
}

const ROW_OF = (i: number) => Math.floor(i / 9);
const COL_OF = (i: number) => i % 9;
const BOX_OF = (i: number) => Math.floor(ROW_OF(i) / 3) * 3 + Math.floor(COL_OF(i) / 3);

function peersOf(i: number): number[] {
  const peers: number[] = [];
  for (let j = 0; j < 81; j++) {
    if (j !== i && (ROW_OF(j) === ROW_OF(i) || COL_OF(j) === COL_OF(i) || BOX_OF(j) === BOX_OF(i))) {
      peers.push(j);
    }
  }
  return peers;
}

// Each cell's row/col/box neighbors never change; compute once.
const PEERS: number[][] = Array.from({ length: 81 }, (_, i) => peersOf(i));

/**
 * Counts solutions up to `cap` via backtracking over cell candidates. Early
 * exit at cap 2 is what makes uniqueness checks cheap during digging.
 */
export function countSolutions(grid: readonly number[], cap: number): number {
  let solutions = 0;
  const work = grid.slice();

  const backtrack = (): void => {
    if (solutions >= cap) {
      return;
    }
    // Most-constrained empty cell keeps the search tree narrow.
    let best = -1;
    let bestCandidates: number[] = [];
    for (let i = 0; i < 81; i++) {
      if (work[i] !== 0) {
        continue;
      }
      const used = new Set<number>();
      for (const peer of PEERS[i]) {
        if (work[peer] !== 0) {
          used.add(work[peer]);
        }
      }
      const candidates: number[] = [];
      for (let v = 1; v <= 9; v++) {
        if (!used.has(v)) {
          candidates.push(v);
        }
      }
      if (candidates.length === 0) {
        return; // dead end
      }
      if (best === -1 || candidates.length < bestCandidates.length) {
        best = i;
        bestCandidates = candidates;
        if (candidates.length === 1) {
          break;
        }
      }
    }
    if (best === -1) {
      solutions += 1;
      return;
    }
    for (const value of bestCandidates) {
      work[best] = value;
      backtrack();
      work[best] = 0;
      if (solutions >= cap) {
        return;
      }
    }
  };

  backtrack();
  return solutions;
}

export function hasUniqueSolution(grid: readonly number[]): boolean {
  return countSolutions(grid, 2) === 1;
}

/**
 * Deterministic PRNG (mulberry32). The same seed must regenerate the same
 * puzzle — lobby restarts and tests both rely on reproducibility.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A complete valid solved grid, grown by randomized backtracking. */
export function generateSolution(random: () => number): Grid {
  const grid: Grid = new Array(81).fill(0);

  const fill = (i: number): boolean => {
    if (i === 81) {
      return true;
    }
    const used = new Set<number>();
    for (const peer of PEERS[i]) {
      if (grid[peer] !== 0) {
        used.add(grid[peer]);
      }
    }
    for (const value of shuffled([1, 2, 3, 4, 5, 6, 7, 8, 9], random)) {
      if (!used.has(value)) {
        grid[i] = value;
        if (fill(i + 1)) {
          return true;
        }
        grid[i] = 0;
      }
    }
    return false;
  };

  fill(0);
  return grid;
}

/**
 * Digs holes from a solved grid down to `targetGivens`, removing a cell only
 * while the puzzle keeps its unique solution. Returns the givens-only board.
 */
export function digHoles(
  solution: readonly number[],
  targetGivens: number,
  random: () => number,
): Grid {
  const puzzle = solution.slice();
  let remaining = 81;
  for (const i of shuffled(
    Array.from({ length: 81 }, (_, index) => index),
    random,
  )) {
    if (remaining <= targetGivens) {
      break;
    }
    const saved = puzzle[i];
    puzzle[i] = 0;
    if (hasUniqueSolution(puzzle)) {
      remaining -= 1;
    } else {
      puzzle[i] = saved;
    }
  }
  return puzzle;
}

export type GeneratedPuzzle = {
  /** The puzzle as players see it: givens plus blanks. */
  givens: Grid;
  /** Server-only: the unique solution placements are validated against. */
  solution: Grid;
};

export function generatePuzzle(difficulty: Difficulty, seed: number): GeneratedPuzzle {
  const random = mulberry32(seed);
  const solution = generateSolution(random);
  const givens = digHoles(solution, DIFFICULTY_GIVENS[difficulty], random);
  return { givens, solution };
}

/** Wire form: 81 chars, digits 1-9, `.` for blanks. */
export function gridToString(grid: readonly number[]): string {
  return grid.map((value) => (value === 0 ? "." : String(value))).join("");
}
