/**
 * Pure decision core of the GameRoom alarm's ghost-seat sweep, kept out of
 * the DO so it can be unit-tested without a runtime. A "ghost" is a seat
 * whose socket vanished without a deliverable close frame; left alone it
 * holds the roster cap forever.
 */
export type SweepPlayer = { id: string; lastSeenAt?: number };

export type GhostSweepPlan = {
  /** Seats to evict, in roster order. */
  ghosts: string[];
  /**
   * Fresh liveness stamps (playerId → timestamp) to apply. Throttled by the
   * caller's stamp interval so extra alarms stay write-free; unstamped
   * legacy seats are stamped so they age in instead of vanishing outright.
   */
  stamps: Map<string, number>;
};

export function planGhostSweep(
  players: readonly SweepPlayer[],
  liveIds: ReadonlySet<string>,
  now: number,
  graceMs: number,
  stampIntervalMs: number,
): GhostSweepPlan {
  const ghosts: string[] = [];
  const stamps = new Map<string, number>();
  for (const player of players) {
    const lastSeen = player.lastSeenAt ?? now;
    // Decided BEFORE any restamp: refreshing a dead seat's clock must never
    // postpone its own eviction past the threshold.
    if (!liveIds.has(player.id) && now - lastSeen > graceMs) {
      ghosts.push(player.id);
      continue;
    }
    if (
      (liveIds.has(player.id) || player.lastSeenAt === undefined) &&
      (player.lastSeenAt === undefined || now - player.lastSeenAt > stampIntervalMs)
    ) {
      stamps.set(player.id, now);
    }
  }
  return { ghosts, stamps };
}
