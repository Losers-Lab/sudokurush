import type { ClientMessage, ServerMessage } from "../../../shared/protocol.ts";

export type CloseInfo = { code: number; reason: string };

export type ConnectionHandlers = {
  onMessage: (message: ServerMessage) => void;
  onClose: (info: CloseInfo) => void;
};

/**
 * Transport-agnostic lobby link. Game code depends only on this, so the same
 * loop runs against the Worker relay or an in-page local lobby.
 */
export interface Connection {
  readonly kind: "socket" | "local";
  send(message: ClientMessage): void;
  close(): void;
}

export function dispatchMessage(handlers: ConnectionHandlers, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (isServerMessage(parsed)) {
    handlers.onMessage(parsed);
  }
}

function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === "object" && value !== null && "t" in value;
}
