import assert from "node:assert/strict";
import test from "node:test";
import { planGhostSweep } from "../worker/src/ghost-sweep.ts";

const NOW = 1_000_000;
const GRACE = 5 * 60_000;
const STAMP = 10 * 60_000;

test("seats past the grace window without a live socket are ghosts", () => {
  const plan = planGhostSweep(
    [
      { id: "live", lastSeenAt: NOW - 1000 },
      { id: "dead", lastSeenAt: NOW - GRACE - 1 },
    ],
    new Set(["live"]),
    NOW,
    GRACE,
    STAMP,
  );
  assert.deepEqual(plan.ghosts, ["dead"]);
});

test("a ghost's clock is never refreshed by its own sweep", () => {
  const plan = planGhostSweep(
    [{ id: "dead", lastSeenAt: NOW - GRACE - 1 }],
    new Set(),
    NOW,
    GRACE,
    STAMP,
  );
  // Eviction decided before restamping; the seat must not appear in stamps.
  assert.equal(plan.stamps.has("dead"), false);
});

test("live seats are restamped at most once per stamp interval", () => {
  const players = [
    { id: "fresh", lastSeenAt: NOW - 1000 },
    { id: "stale", lastSeenAt: NOW - STAMP - 1 },
  ];
  const plan = planGhostSweep(players, new Set(["fresh", "stale"]), NOW, GRACE, STAMP);
  assert.deepEqual(plan.ghosts, []);
  assert.deepEqual([...plan.stamps.keys()], ["stale"]);
});

test("legacy seats without a stamp age in instead of vanishing", () => {
  const plan = planGhostSweep([{ id: "legacy" }], new Set(), NOW, GRACE, STAMP);
  assert.deepEqual(plan.ghosts, []);
  assert.equal(plan.stamps.get("legacy"), NOW);
});
