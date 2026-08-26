import type { GameState } from "../game/gameClient.ts";
import type { Difficulty } from "../../../shared/protocol.ts";
import { el, replaceChildren, type Screen } from "./dom.ts";

export type LobbyActions = {
  onStart(difficulty: Difficulty): void;
  onRename(name: string): void;
  onLeave(): void;
};

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

/**
 * The WAITING room: roster, shareable lobby code, and the host's launch
 * controls. Everyone sees the same roster; only the host sees live controls.
 */
export function createLobbyScreen(root: HTMLElement, actions: LobbyActions): Screen {
  const panel = el("div", "lobby-screen");

  const head = el("div", "lobby-head");
  const title = el("h1", "app-title", "SudokuRush");
  const tagline = el("p", "app-tagline", "One board. Every hand helps.");
  head.append(title, tagline);

  const codeCard = el("div", "code-card");
  const codeLabel = el("span", "code-label", "Lobby code");
  const codeValue = el("button", "code-value");
  codeValue.type = "button";
  const codeHint = el("span", "code-hint", "tap to copy");
  codeValue.addEventListener("click", async () => {
    const code = codeValue.dataset.code ?? "";
    if (!code) {
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      codeHint.textContent = "copied!";
    } catch {
      codeHint.textContent = code;
    }
    setTimeout(() => {
      codeHint.textContent = "tap to copy";
    }, 1500);
  });
  codeCard.append(codeLabel, codeValue, codeHint);

  const nameRow = el("div", "name-row");
  const nameLabel = el("label", "field-label", "Your name");
  const nameInput = el("input", "field-input") as HTMLInputElement;
  nameInput.maxLength = 32;
  nameInput.addEventListener("change", () => actions.onRename(nameInput.value));
  nameRow.append(nameLabel, nameInput);

  const rosterCard = el("div", "roster-card");
  const rosterTitle = el("h2", "card-title", "Players");
  const rosterList = el("ul", "roster-list");
  rosterCard.append(rosterTitle, rosterList);

  const controls = el("div", "lobby-controls");
  const difficultySelect = el("select", "field-input") as HTMLSelectElement;
  for (const difficulty of ["easy", "medium", "hard"] as Difficulty[]) {
    const option = el("option", undefined, DIFFICULTY_LABELS[difficulty]);
    option.value = difficulty;
    difficultySelect.append(option);
  }
  const startButton = el("button", "btn btn-primary", "Start puzzle");
  startButton.type = "button";
  startButton.addEventListener("click", () => actions.onStart(difficultySelect.value as Difficulty));
  const waitingNote = el("p", "waiting-note", "Waiting for the host to start…");
  const leaveButton = el("button", "btn btn-ghost", "Leave");
  leaveButton.type = "button";
  leaveButton.addEventListener("click", () => actions.onLeave());
  controls.append(difficultySelect, startButton, waitingNote);

  panel.append(head, codeCard, nameRow, rosterCard, controls, leaveButton);
  root.replaceChildren(panel);

  let lastKind: string | null = null;

  function paintRoster(state: GameState): void {
    replaceChildren(
      rosterList,
      ...state.players.map((player, index) => {
        const row = el("li", `roster-row${player.online ? "" : " offline"}`);
        // Every seat owns a hue; it follows the player across UI surfaces.
        row.style.setProperty("--pc", `var(--p${index % 8})`);
        const avatar =
          player.avatar
            ? (() => {
                const img = el("img", "avatar") as HTMLImageElement;
                img.src = `https://cdn.discordapp.com/avatars/${player.id}/${player.avatar}.png?size=64`;
                img.alt = "";
                return img;
              })()
            : el("span", "avatar avatar-fallback", player.name.slice(0, 1).toUpperCase());
        const name = el("span", "roster-name", player.name);
        if (player.isYou) {
          name.textContent += " (you)";
        }
        const badges = el("span", "roster-badges");
        badges.append(el("i", `online-dot${player.online ? " on" : ""}`));
        if (player.isHost) {
          badges.append(el("span", "badge badge-host", "host"));
        }
        badges.append(
          el("span", `badge ${player.online ? "badge-online" : "badge-offline"}`, player.online ? "online" : "offline"),
        );
        row.append(avatar, name, badges);
        return row;
      }),
    );
  }

  return {
    update(state: GameState) {
      const code = currentRoomCode();
      codeValue.textContent = code ?? "—";
      codeValue.dataset.code = code ?? "";
      codeCard.style.display = state.connectionKind === "local" || !code ? "none" : "";
      nameInput.placeholder = state.name;
      paintRoster(state);
      const isHost = state.isHost;
      difficultySelect.style.display = isHost ? "" : "none";
      startButton.style.display = isHost ? "" : "none";
      waitingNote.style.display = isHost ? "none" : "";
      leaveButton.textContent = state.connectionKind === "local" ? "Play online instead" : "Leave";
      if (state.connectionKind !== lastKind) {
        lastKind = state.connectionKind;
      }
    },
    destroy() {
      panel.remove();
    },
  };
}

/** Reads the ?room= style code back out of the URL (single source: location). */
function currentRoomCode(): string | null {
  const raw = new URLSearchParams(window.location.search).get("room");
  if (!raw) {
    return null;
  }
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
}
