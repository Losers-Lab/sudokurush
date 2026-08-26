import type { RoundTally } from "./protocol";

export type StandingRow = {
  playerId: string;
  name: string;
  wins: number;
  solves: number;
};

/**
 * Pure session standings math — no Durable Object state, no I/O — so the
 * victory screen and the relay agree on ordering without either trusting a
 * client sort.
 *
 * Ordering: wins first (a win is the whole point), then total solves as the
 * consistency tiebreak, then seat name and id so the result is deterministic
 * for tests regardless of roster order.
 */
export function sortStandings(
  players: readonly { id: string; name: string }[],
  tallies: Readonly<Record<string, RoundTally>>,
): StandingRow[] {
  return players
    .map((player) => {
      const tally = tallies[player.id] ?? { wins: 0, solves: 0 };
      return {
        playerId: player.id,
        name: player.name,
        wins: tally.wins,
        solves: tally.solves,
      };
    })
    .sort((a, b) => {
      if (a.wins !== b.wins) return b.wins - a.wins;
      if (a.solves !== b.solves) return b.solves - a.solves;
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.playerId.localeCompare(b.playerId);
    });
}
