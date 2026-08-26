import type { GameState } from "../game/gameClient";
import { el } from "../ui/dom";

/**
 * The one shared Sudoku board. Purely presentational: it paints whatever the
 * authoritative snapshot says, highlights whose digit landed where, and
 * reports selection clicks upward. It holds no game rules of its own.
 */

export const CELL_COUNT = 81;

const PLAYER_COLOR_CLASSES = [
  "owner-0",
  "owner-1",
  "owner-2",
  "owner-3",
  "owner-4",
  "owner-5",
  "owner-6",
  "owner-7",
];

export type BoardCallbacks = {
  /** Selection moved (null = deselected). The caller relays it as a cursor. */
  onSelect: (i: number | null) => void;
};

export interface BoardView {
  update(state: GameState): void;
  readonly selected: number | null;
  setSelected(i: number | null): void;
  flashWrong(i: number): void;
  /** Peer selection ring by player id; null hides that player's ring. */
  setPeerCursor(playerId: string, i: number | null): void;
  destroy(): void;
}

type CellRefs = {
  root: HTMLButtonElement;
  value: HTMLElement;
  notes: HTMLElement[];
};

export function createBoardView(root: HTMLElement, callbacks: BoardCallbacks): BoardView {
  const grid = el("div", "board");
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", "Shared sudoku board");
  const cells: CellRefs[] = [];
  let selected: number | null = null;
  // playerId -> peer-cursor cell index; painted as colored rings.
  const peerCursors = new Map<string, number>();
  // playerId -> palette slot derived from roster order at last update.
  const ownerClasses = new Map<string, string>();
  let destroyed = false;

  for (let i = 0; i < CELL_COUNT; i++) {
    const cellRoot = el("button", "cell");
    cellRoot.type = "button";
    cellRoot.dataset.i = String(i);
    // Heavy box borders every third line make the 3x3 boxes readable without
    // any extra chrome; CSS :nth-child does the layout work.
    if ((i % 9) % 3 === 2 && i % 9 !== 8) cellRoot.classList.add("edge-right");
    if (Math.floor(i / 9) % 3 === 2 && Math.floor(i / 9) !== 8) cellRoot.classList.add("edge-bottom");
    const value = el("span", "cell-value");
    const noteGrid = el("div", "cell-notes");
    const noteSlots: HTMLElement[] = [];
    for (let v = 1; v <= 9; v++) {
      const slot = el("span", "note-slot");
      slot.textContent = String(v);
      noteGrid.append(slot);
      noteSlots.push(slot);
    }
    cellRoot.append(value, noteGrid);
    cellRoot.addEventListener("click", () => select(i));
    grid.append(cellRoot);
    cells.push({ root: cellRoot, value, notes: noteSlots });
  }

  root.append(grid);

  function select(i: number | null): void {
    if (destroyed || selected === i) {
      return;
    }
    selected = i;
    paintSelection();
    callbacks.onSelect(i);
  }

  function paintSelection(): void {
    cells.forEach((cell, i) => {
      cell.root.classList.toggle("selected", selected === i);
      cell.root.setAttribute("aria-selected", selected === i ? "true" : "false");
    });
  }

  function paintPeerCursors(): void {
    cells.forEach((cell) => cell.root.classList.remove("peer-0", "peer-1", "peer-2", "peer-3"));
    let slot = 0;
    for (const [playerId, cellIndex] of peerCursors) {
      if (!ownerClasses.has(playerId)) {
        continue;
      }
      cells[cellIndex]?.root.classList.add(`peer-${slot % 4}`);
      slot += 1;
    }
  }

  return {
    get selected() {
      return selected;
    },
    setSelected(i: number | null) {
      select(i);
    },
    update(state: GameState) {
      if (destroyed) {
        return;
      }
      // Palette slots follow roster order so colors stay stable while the
      // lobby is unchanged and never collide between seats.
      ownerClasses.clear();
      state.players.forEach((player, index) => {
        ownerClasses.set(
          player.id,
          PLAYER_COLOR_CLASSES[index % PLAYER_COLOR_CLASSES.length],
        );
      });
      for (let i = 0; i < CELL_COUNT; i++) {
        const cell = cells[i];
        const char = state.board[i] ?? ".";
        const isGiven = state.givens[i] !== "." && state.givens[i] !== undefined;
        cell.root.classList.toggle("given", isGiven && char !== ".");
        cell.root.classList.toggle("filled", char !== ".");
        cell.root.classList.toggle("editable", !isGiven && char === ".");
        if (char !== ".") {
          cell.value.textContent = char;
          cell.root.classList.remove("has-notes");
          for (const slot of cell.notes) {
            slot.classList.remove("on");
          }
          const ownerClass = ownerClasses.get(state.owners[String(i)] ?? "");
          cell.root.className = cell.root.className.replace(/owner-\d/g, "").trim();
          if (ownerClass && !isGiven) {
            cell.root.classList.add(ownerClass);
          }
        } else {
          cell.value.textContent = "";
          const values = new Set(state.notes[String(i)] ?? []);
          cell.root.classList.toggle("has-notes", values.size > 0);
          cell.notes.forEach((slot, index) => {
            slot.classList.toggle("on", values.has(index + 1));
          });
        }
      }
      paintSelection();
      paintPeerCursors();
    },
    flashWrong(i: number) {
      if (destroyed) {
        return;
      }
      const cell = cells[i];
      cell?.root.classList.remove("wrong");
      // Force a reflow so repeat misses restart the shake instead of no-op.
      void cell?.root.offsetWidth;
      cell?.root.classList.add("wrong");
      setTimeout(() => cell?.root.classList.remove("wrong"), 450);
    },
    setPeerCursor(playerId: string, i: number | null) {
      if (destroyed) {
        return;
      }
      if (i === null) {
        peerCursors.delete(playerId);
      } else {
        peerCursors.set(playerId, i);
      }
      paintPeerCursors();
    },
    destroy() {
      destroyed = true;
      grid.remove();
    },
  };
}
