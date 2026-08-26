import assert from "node:assert/strict";
import test from "node:test";
import {
  countSolutions,
  generatePuzzle,
  generateSolution,
  gridToString,
  hasUniqueSolution,
} from "../shared/sudoku.ts";

function assertValidSolution(grid: readonly number[]): void {
  assert.equal(grid.length, 81);
  const seen = new Set<number>();
  for (let unit = 0; unit < 9; unit++) {
    // rows
    for (let col = 0; col < 9; col++) seen.add(grid[unit * 9 + col]!);
    assert.equal(seen.size, 9, `row ${unit} is a permutation`);
    seen.clear();
    // columns
    for (let row = 0; row < 9; row++) seen.add(grid[row * 9 + unit]!);
    assert.equal(seen.size, 9, `column ${unit} is a permutation`);
    seen.clear();
    // boxes
    const boxRow = Math.floor(unit / 3) * 3;
    const boxCol = (unit % 3) * 3;
    for (let dr = 0; dr < 3; dr++) {
      for (let dc = 0; dc < 3; dc++) {
        seen.add(grid[(boxRow + dr) * 9 + boxCol + dc]!);
      }
    }
    assert.equal(seen.size, 9, `box ${unit} is a permutation`);
    seen.clear();
  }
}

test("generated solutions are valid permutations of every unit", () => {
  for (const seed of [1, 42, 987654]) {
    assertValidSolution(generateSolution(() => 0.5 + seed * 1e-9));
  }
});

test("puzzles keep a unique solution consistent with the givens", () => {
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const { givens, solution } = generatePuzzle(difficulty, 2026);
    assert.ok(hasUniqueSolution(givens), `${difficulty} puzzle must have exactly one solution`);
    givens.forEach((value, i) => {
      if (value !== 0) {
        assert.equal(value, solution[i], `given ${i} must sit on the solution cell`);
      }
    });
    assertValidSolution(solution);
  }
});

test("difficulty controls how many clues survive", () => {
  const easy = generatePuzzle("easy", 7).givens.filter((v) => v !== 0).length;
  const medium = generatePuzzle("medium", 7).givens.filter((v) => v !== 0).length;
  const hard = generatePuzzle("hard", 7).givens.filter((v) => v !== 0).length;
  assert.ok(easy > medium, `easy (${easy}) should keep more clues than medium (${medium})`);
  assert.ok(medium > hard, `medium (${medium}) should keep more clues than hard (${hard})`);
});

test("the same seed regenerates the same puzzle", () => {
  const a = generatePuzzle("medium", 31337);
  const b = generatePuzzle("medium", 31337);
  assert.deepEqual(a.givens, b.givens);
  assert.deepEqual(a.solution, b.solution);
});

test("countSolutions distinguishes unique from wide-open boards", () => {
  const solved = generateSolution(Math.random);
  assert.equal(countSolutions(solved, 2), 1);
  // An unconstrained grid completes in many ways; cap 2 proves early exit.
  const blank = new Array(81).fill(0);
  assert.equal(countSolutions(blank, 2), 2);
});

test("gridToString uses dots for blanks and digits otherwise", () => {
  assert.equal(gridToString([5, 0, 0, 3, 0]), "5..3.");
});
