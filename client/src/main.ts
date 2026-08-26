import "./theme.css";
import type { Difficulty } from "../../shared/protocol.ts";
import { GameClient, type GameState } from "./game/gameClient.ts";
import type { BoardView } from "./board/boardView.ts";
import { createPlayScreen } from "./ui/playScreen.ts";
import type { ConnectionHandlers } from "./net/connection.ts";
import { LocalConnection } from "./net/localConnection.ts";
import { newRoomCode, normalizeJoinCode } from "./net/openRooms.ts";
import { SocketConnection } from "./net/socketConnection.ts";
import { sfx } from "./audio/sfx.ts";
import { el, type Screen } from "./ui/dom.ts";
import { createLobbyScreen } from "./ui/lobbyScreen.ts";
import { createVictoryScreen } from "./ui/victoryScreen.ts";

// Discord mobile hosts activities as a TOP-LEVEL WebView (native bridge, no
// parent frame), so the frame check alone misses phones; Discord's WebView
// announces itself in the user agent instead.
const DISCORD_UA = /discord/i.test(navigator.userAgent);
const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID ?? "";
const NAME_KEY = "sudokurush.name";
const UID_KEY = "sudokurush.uid";

type Identity = {
  /** Stable seat id: the Discord user id, or a persisted random guest UUID. */
  userId: string;
  name: string;
  avatar: string | null;
  /** Present when launched as an embedded activity; owns the room decision. */
  instanceId: string | null;
};

const app = document.getElementById("app")!;

console.log(`[sudokurush] build ${__BUILD_ID__}`);

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

function guestId(): string {
  let id = localStorage.getItem(UID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(UID_KEY, id);
  }
  return id;
}

function storedName(): string {
  const name = localStorage.getItem(NAME_KEY)?.trim();
  return name || `Player ${Math.floor(100 + Math.random() * 900)}`;
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim());
  } catch {
    // Private mode may refuse storage; the session keeps working unnamed.
  }
}

function discordAvatarUrl(userId: string, hash: string): string {
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=64`;
}

/**
 * Full handshake only inside a Discord activity iframe; plain-browser dev
 * and guest sessions skip straight to a local identity. Any failure inside
 * Discord degrades to a guest seat rather than blocking play.
 */
async function resolveIdentity(): Promise<Identity> {
  const embedded = window.frameElement !== null || DISCORD_UA;
  if (!embedded || !CLIENT_ID) {
    if (embedded && !CLIENT_ID) {
      console.warn(
        "[sudokurush] discord sign-in skipped: VITE_DISCORD_CLIENT_ID is not baked into this build",
      );
    }
    return { userId: guestId(), name: storedName(), avatar: null, instanceId: null };
  }

  try {
    const { DiscordSDK } = await import("@discord/embedded-app-sdk");
    const sdk = new DiscordSDK(CLIENT_ID);
    // In a plain browser the bridge never answers; give up to guest quickly
    // instead of hanging the boot screen on a session that will never come.
    await Promise.race([
      sdk.ready(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("sdk bridge timeout")), 4000)),
    ]);

    const { code } = await sdk.commands.authorize({
      client_id: CLIENT_ID,
      scope: ["identify", "guilds.members.read"],
      prompt: "none",
    });
    // The OAuth code is single-use and short-lived: exchange it on our own
    // worker so the client secret never touches the client bundle.
    const tokenResponse = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!tokenResponse.ok) {
      throw new Error(`token exchange failed (HTTP ${tokenResponse.status})`);
    }
    const { access_token } = (await tokenResponse.json()) as { access_token: string };

    // Response schema drifts between SDK majors; read only the fields we need.
    const auth = (await sdk.commands.authenticate({ access_token })) as {
      user: { id: string; username: string; global_name?: string | null; avatar?: string | null };
    };
    let avatar = auth.user.avatar ? discordAvatarUrl(auth.user.id, auth.user.avatar) : null;
    const name = auth.user.global_name ?? auth.user.username;

    // Guild-specific avatars override the global one when present.
    if (sdk.guildId) {
      try {
        const member = await fetch(
          `https://discord.com/api/users/@me/guilds/${sdk.guildId}/member`,
          { headers: { Authorization: `Bearer ${access_token}` } },
        ).then((response) => (response.ok ? response.json() : null));
        const memberAvatar = member?.avatar;
        if (typeof memberAvatar === "string") {
          avatar = `https://cdn.discordapp.com/guilds/${sdk.guildId}/users/${auth.user.id}/${memberAvatar}.png?size=64`;
        }
      } catch {
        // Cosmetic only; the global avatar already covers it.
      }
    }

    return {
      userId: auth.user.id,
      name: name || "Player",
      avatar,
      instanceId: sdk.instanceId,
    };
  } catch (error) {
    console.warn("[sudokurush] discord sign-in failed", error);
    return { userId: guestId(), name: storedName(), avatar: null, instanceId: null };
  }
}

/* ------------------------------------------------------------------ */
/* Session state                                                       */
/* ------------------------------------------------------------------ */

const identity = await resolveIdentity();

let client: GameClient | null = null;
let screen: Screen | null = null;
let activeBoard: BoardView | null = null;
let activePhase: GameState["phase"] | null = null;
let bootPanel: HTMLElement | null = null;
let latestState: GameState | null = null;
const peerCursors = new Map<string, number>();

function board(): BoardView | null {
  return activeBoard;
}

/* ------------------------------------------------------------------ */
/* Boot panel                                                          */
/* ------------------------------------------------------------------ */

function showBoot(reason?: string): void {
  destroyScreen();
  client?.dispose();
  client = null;
  peerCursors.clear();
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  window.history.replaceState(null, "", url);

  bootPanel ??= buildBootPanel();
  app.replaceChildren(bootPanel);
  const notice = bootPanel.querySelector<HTMLElement>(".boot-notice");
  if (notice) {
    notice.textContent = reason ?? "";
  }
}

function destroyBootIfAny(): void {
  if (bootPanel?.isConnected) {
    bootPanel.remove();
  }
}

function destroyScreen(): void {
  activeBoard = null;
  screen?.destroy();
  screen = null;
}

function buildBootPanel(): HTMLElement {
  const panel = el("div", "lobby-screen");
  const head = el("div", "lobby-head");
  head.append(
    el("h1", "app-title", "SudokuRush"),
    el("p", "app-tagline", "One board. Every hand helps."),
  );

  const noticeEl = el("p", "notice-bar boot-notice");

  const createButton = el("button", "btn btn-primary", "Create a lobby");
  createButton.type = "button";
  createButton.addEventListener("click", () => openSocketRoom(`open:${newRoomCode()}`));

  const joinLabel = el("label", "field-label", "Join with a code");
  const joinField = el("input", "field-input") as HTMLInputElement;
  joinField.placeholder = "ABC123";
  joinField.maxLength = 12;
  const joinClicked = (): void => {
    const code = normalizeJoinCode(joinField.value);
    if (!code) {
      noticeEl.textContent = "Codes are six letters/digits — check the invite?";
      return;
    }
    openSocketRoom(`open:${code}`);
  };
  joinField.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      joinClicked();
    }
  });
  const joinButton = el("button", "btn", "Join");
  joinButton.type = "button";
  joinButton.addEventListener("click", joinClicked);

  const soloButton = el("button", "btn btn-ghost", "Practice solo");
  soloButton.type = "button";
  soloButton.addEventListener("click", () => openSolo());

  const row = el("div", "join-row");
  row.append(joinField, joinButton);

  panel.append(head, noticeEl, createButton, joinLabel, row, soloButton);
  return panel;
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

function handlers(): ConnectionHandlers {
  return {
    onMessage: (message) => client?.onMessage(message),
    onClose: () => linkLost(),
  };
}

const MAX_RECONNECT_ATTEMPTS = 3;

let currentRoomId: string | null = null;
let reconnectAttempt = 0;

function openSocketRoom(roomId: string): void {
  destroyBootIfAny();
  currentRoomId = roomId;
  reconnectAttempt = 0;
  syncRoomUrl(roomId);
  client?.dispose();
  client = new GameClient(gameEvents(), identity.name, identity.avatar);
  connectAttempt();
}

/**
 * The lobby screen reads its shareable code straight out of the URL, so an
 * `open:` room keeps ?room= current: a fresh lobby gets a copyable invite and
 * a refresh rejoins instead of dumping back at the menu. Discord instance ids
 * are not joinable codes and never belong in the address bar.
 */
function syncRoomUrl(roomId: string): void {
  if (!roomId.startsWith("open:")) {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId.slice("open:".length));
  window.history.replaceState(null, "", url);
}

function connectAttempt(): void {
  if (!client || !currentRoomId) {
    return;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/api/room/${encodeURIComponent(currentRoomId)}?player=${encodeURIComponent(identity.userId)}`;
  client.connect(new SocketConnection(url, handlers()));
  if (reconnectAttempt > 0) {
    // Same stable seat id, so a successful retry reclaims the roster spot.
    client.pauseForReconnect(reconnectAttempt, MAX_RECONNECT_ATTEMPTS);
  }
}

/**
 * Transport died. Retry with backoff while the last known lobby stays
 * rendered under a notice; exhausted retries fall back to solo practice so
 * the session always ends somewhere playable.
 */
function linkLost(): void {
  if (!client) {
    return;
  }
  if (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempt += 1;
    client.pauseForReconnect(reconnectAttempt, MAX_RECONNECT_ATTEMPTS);
    setTimeout(() => {
      if (client && !client.connected) {
        connectAttempt();
      }
    }, reconnectAttempt * 800);
    return;
  }
  openSolo("connection lost — practicing solo");
}

/* ------------------------------------------------------------------ */
/* Solo fallback                                                       */
/* ------------------------------------------------------------------ */

/**
 * Solo practice loopback. Runs the relay's own rules locally — same
 * validation, same completion detection — so practice never teaches bad
 * habits.
 */
function openSolo(notice?: string): void {
  destroyBootIfAny();
  client?.dispose();
  client = new GameClient(gameEvents(), identity.name, identity.avatar);
  client.connect(new LocalConnection(handlers(), identity.name));
  if (notice) {
    client.degradeToSolo(notice);
  }
}

/* ------------------------------------------------------------------ */
/* Game events → screens                                               */
/* ------------------------------------------------------------------ */

function gameEvents() {
  return {
    onState: onGameState,
    onInvalid: (i: number) => {
      board()?.flashWrong(i);
      sfx.wrong();
    },
    onCellUpdated: () => sfx.place(),
    onNoteChanged: () => sfx.note(),
    onPeerCursor: (byPlayer: string, i: number) => {
      peerCursors.set(byPlayer, i);
      board()?.setPeerCursor(byPlayer, i);
    },
    onLinkLost: () => {
      // Transport bookkeeping lives in the connection layer.
    },
  };
}

function onGameState(state: GameState): void {
  latestState = state;
  if (state.phase === "boot") {
    return;
  }
  if (state.phase !== activePhase) {
    const previous = activePhase;
    destroyScreen();
    activePhase = state.phase;
    switch (state.phase) {
      case "playing":
        screen = createPlayScreen(app, {
          onDigit: handleDigit,
          onSelect: (i) => {
            if (i !== null) {
              client?.sendCursor(i);
            }
          },
        });
        activeBoard = (screen as ReturnType<typeof createPlayScreen>).board;
        break;
      case "victory":
        screen = createVictoryScreen(app, {
          onPlayAgain: (difficulty) => client?.startGame(difficulty),
          onLeave: () => leaveLobby(),
        });
        if (previous === "playing") {
          sfx.completed();
        }
        break;
      default:
        screen = createLobbyScreen(app, {
          onStart: (difficulty: Difficulty) => client?.startGame(difficulty),
          onRename: (name) => {
            identity.name = name;
            rememberName(name);
            client?.rename(name);
          },
          onLeave: () => leaveLobby(),
        });
        break;
    }
  }
  screen?.update(state);
  // Prune cursors for seats that vanished while we were looking elsewhere.
  for (const playerId of peerCursors.keys()) {
    if (!state.players.some((player) => player.id === playerId)) {
      peerCursors.delete(playerId);
      board()?.setPeerCursor(playerId, null);
    }
  }
}

/** Numpad and keyboard both land here; note mode toggles instead of writing. */
function handleDigit(v: number, asNote: boolean): void {
  const view = board();
  const i = view?.selected;
  if (!client || i === null || i === undefined || i < 0) {
    return;
  }
  if (asNote) {
    const existing = latestState?.notes[String(i)] ?? [];
    if (existing.includes(v)) {
      client.removeNote(i, v);
    } else {
      client.addNote(i, v);
    }
    return;
  }
  client.place(i, v);
}

function leaveLobby(): void {
  showBoot();
}

/* Keyboard input mirrors the numpad; arrows move the selection. Shift+digit
   toggles a pencil mark, matching the Notes button. */
window.addEventListener("keydown", (event) => {
  if (activePhase !== "playing" || !client) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
    return;
  }
  if (/^[1-9]$/.test(event.key)) {
    handleDigit(Number(event.key), event.shiftKey);
    return;
  }
  const view = board();
  if (!view) {
    return;
  }
  if (event.key === "Escape") {
    view.setSelected(null);
    return;
  }
  const deltas: Record<string, [number, number]> = {
    ArrowUp: [-9, 0],
    ArrowDown: [9, 0],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 8],
  };
  const move = deltas[event.key];
  if (!move) {
    return;
  }
  event.preventDefault();
  const current = view.selected ?? 0;
  const next = current + move[0];
  if (next >= 0 && next < 81 && !(event.key === "ArrowLeft" && current % 9 === 0)) {
    view.setSelected(next);
  }
});

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

const joinCode =
  identity.instanceId === null
    ? normalizeJoinCode(new URLSearchParams(window.location.search).get("room"))
    : null;

// Demo/testing shortcuts (#solo, #play): jump straight into a practice
// session, optionally dealing a puzzle immediately. Harmless in production;
// handy for screenshots and quick checks.
const demoMode = window.location.hash === "#solo" || window.location.hash === "#play";
const autoDeal = window.location.hash === "#play";

if (identity.instanceId !== null) {
  // A Discord instance IS its room; browser-style codes never apply there.
  openSocketRoom(identity.instanceId);
} else if (joinCode) {
  openSocketRoom(`open:${joinCode}`);
} else if (demoMode) {
  openSolo();
} else {
  showBoot();
}

if (demoMode && autoDeal) {
  const dealWhenReady = setInterval(() => {
    if (latestState?.phase === "lobby" && latestState.isHost) {
      clearInterval(dealWhenReady);
      client?.startGame("easy");
    }
  }, 200);
  setTimeout(() => clearInterval(dealWhenReady), 10_000);
}
