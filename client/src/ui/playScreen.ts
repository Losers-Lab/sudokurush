import type { GameState } from "../game/gameClient.ts";
import { createBoardView, type BoardView } from "../board/boardView.ts";
import { el, formatClock, replaceChildren, type Screen } from "./dom.ts";

export type PlayActions = {
  /** Digit submitted in the current mode; the screen owns number-vs-notes. */
  onDigit(v: number, asNote: boolean): void;
  onSelect(i: number | null): void;
};

/**
 * The IN_PROGRESS screen: shared board front and center, live player panel
 * beside it, and a thumb-reachable number pad. Notes mode toggles per seat —
 * it is an input preference, never shared state.
 */
export function createPlayScreen(
  root: HTMLElement,
  actions: PlayActions,
): Screen & { board: BoardView } {
  const panel = el("div", "play-screen");

  const header = el("div", "play-header");
  const codeChip = el("span", "chip chip-code");
  const timer = el("span", "chip chip-timer", "00:00");
  const statusChip = el("span", "chip chip-status");
  header.append(codeChip, statusChip, timer);

  const main = el("div", "play-main");
  const boardHost = el("div", "board-host");
  const side = el("div", "side-panel");

  const playersTitle = el("h2", "card-title", "Lobby");
  const playerList = el("ul", "player-list");
  side.append(playersTitle, playerList);

  const noticeBar = el("div", "notice-bar");

  const pad = el("div", "numpad-wrap");
  const modeToggle = el("button", "btn btn-mode", "✏️ Notes: off");
  modeToggle.type = "button";
  let notesMode = false;
  modeToggle.addEventListener("click", () => {
    notesMode = !notesMode;
    modeToggle.textContent = `✏️ Notes: ${notesMode ? "on" : "off"}`;
    modeToggle.classList.toggle("active", notesMode);
  });
  const numpad = el("div", "numpad");
  const digitButtons: HTMLButtonElement[] = [];
  for (let v = 1; v <= 9; v++) {
    const button = el("button", "btn btn-digit", String(v));
    button.type = "button";
    button.addEventListener("click", () => actions.onDigit(v, notesMode));
    digitButtons.push(button);
    numpad.append(button);
  }
  const modeHint = el("p", "mode-hint", "Notes add pencil marks others can see. Numbers must be correct.");
  pad.append(modeToggle, numpad, modeHint);

  main.append(boardHost, side);
  panel.append(header, noticeBar, main, pad);
  root.replaceChildren(panel);

  const board = createBoardView(boardHost, {
    onSelect: (i) => actions.onSelect(i),
  });

  function paintPlayers(state: GameState): void {
    // Total blanks is the shared goal everyone's bar fills toward.
    const totalEditable = [...state.givens].filter((char) => char === ".").length || 1;
    replaceChildren(
      playerList,
      ...state.players.map((player, index) => {
        const row = el("li", `player-row${player.online ? "" : " offline"}`);
        row.style.setProperty("--pc", `var(--p${index % 8})`);
        const nameSpan = el("span", "player-name");
        nameSpan.textContent =
          (player.isHost ? "♛ " : "") + player.name + (player.isYou ? " (you)" : "");
        const stats = el(
          "span",
          "player-stats",
          `${player.placements} placed · ${player.mistakes} miss${player.mistakes === 1 ? "" : "es"}`,
        );
        const progress = el("div", "player-progress");
        const fill = el("div", "player-progress-fill");
        const pct = Math.min(100, Math.round((player.placements / totalEditable) * 100));
        fill.style.width = `${pct}%`;
        if (pct > 0 && player.online) {
          fill.style.boxShadow = "0 0 10px currentColor";
        }
        progress.append(fill);
        row.append(nameSpan, stats, progress);
        return row;
      }),
    );
  }

  return {
    board,
    update(state: GameState) {
      codeChip.textContent = roomCode() ? `#${roomCode()}` : "solo";
      timer.textContent = formatClock(state.elapsedSeconds);
      statusChip.textContent = `${state.players.filter((p) => p.online).length} online · ${state.difficulty}`;
      board.update(state);
      paintPlayers(state);
      if (state.notice) {
        noticeBar.textContent = state.notice.text;
        noticeBar.className = `notice-bar visible ${state.notice.kind}`;
      } else {
        noticeBar.className = "notice-bar";
      }
    },
    destroy() {
      board.destroy();
      panel.remove();
    },
  };
}

function roomCode(): string | null {
  const raw = new URLSearchParams(window.location.search).get("room");
  if (!raw) {
    return null;
  }
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
}
