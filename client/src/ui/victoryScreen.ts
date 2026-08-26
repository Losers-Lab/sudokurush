import type { GameState } from "../game/gameClient.ts";
import type { Difficulty } from "../../../shared/protocol.ts";
import { el, formatClock, replaceChildren, type Screen } from "./dom.ts";

export type VictoryActions = {
  onPlayAgain(difficulty: Difficulty): void;
  onLeave(): void;
};

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

/**
 * The COMPLETED screen: shared fanfare — solve time, and who contributed
 * what. The host can deal a fresh puzzle; everyone else waits (and sees
 * that they are waiting).
 */
export function createVictoryScreen(root: HTMLElement, actions: VictoryActions): Screen {
  const panel = el("div", "victory-screen");

  const head = el("div", "victory-head");
  const banner = el("h1", "victory-banner", "Puzzle solved! 🎉");
  const summary = el("p", "victory-summary");
  head.append(banner, summary);

  const tableCard = el("div", "roster-card");
  const tableTitle = el("h2", "card-title", "Contributions");
  const table = el("ul", "roster-list contribution-list");
  tableCard.append(tableTitle, table);

  const controls = el("div", "lobby-controls");
  const difficultySelect = el("select", "field-input") as HTMLSelectElement;
  for (const difficulty of ["easy", "medium", "hard"] as Difficulty[]) {
    const option = el("option", undefined, DIFFICULTY_LABELS[difficulty]);
    option.value = difficulty;
    difficultySelect.append(option);
  }
  const againButton = el("button", "btn btn-primary", "Play another puzzle");
  againButton.type = "button";
  againButton.addEventListener("click", () => actions.onPlayAgain(difficultySelect.value as Difficulty));
  const waitingNote = el("p", "waiting-note", "Waiting for the host to deal the next puzzle…");
  const leaveButton = el("button", "btn btn-ghost", "Leave lobby");
  leaveButton.type = "button";
  leaveButton.addEventListener("click", () => actions.onLeave());
  controls.append(difficultySelect, againButton, waitingNote, leaveButton);

  panel.append(head, tableCard, controls);
  root.replaceChildren(panel);

  return {
    update(state: GameState) {
      summary.textContent = `Solved together in ${formatClock(state.elapsedSeconds)} · ${DIFFICULTY_LABELS[state.difficulty]}`;
      const rows = [...state.players].sort((a, b) => b.placements - a.placements || a.name.localeCompare(b.name));
      replaceChildren(
        table,
        ...rows.map((player) => {
          const row = el("li", "roster-row");
          const nameSpan = el("span", "roster-name");
          nameSpan.textContent =
            (player.isHost ? "♛ " : "") + player.name + (player.isYou ? " (you)" : "");
          const badges = el("span", "roster-badges");
          badges.append(el("span", "badge", `${player.placements} placed`));
          if (player.mistakes > 0) {
            badges.append(el("span", "badge badge-miss", `${player.mistakes} misses`));
          }
          if (!player.online) {
            badges.append(el("span", "badge badge-offline", "left"));
          }
          row.append(nameSpan, badges);
          return row;
        }),
      );
      const isHost = state.isHost;
      difficultySelect.style.display = isHost ? "" : "none";
      againButton.style.display = isHost ? "" : "none";
      waitingNote.style.display = isHost ? "none" : "";
    },
    destroy() {
      panel.remove();
    },
  };
}
