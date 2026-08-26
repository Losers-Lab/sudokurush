import type { ClientMessage } from "../../../shared/protocol.ts";
import { PING_MESSAGE } from "../../../shared/protocol.ts";
import { dispatchMessage, type CloseInfo, type Connection, type ConnectionHandlers } from "./connection.ts";

const PING_INTERVAL_MS = 25_000;

export class SocketConnection implements Connection {
  readonly kind = "socket" as const;

  private readonly socket: WebSocket;
  private readonly handlers: ConnectionHandlers;
  private readonly pingTimer: ReturnType<typeof setInterval>;
  // The opening hello races the handshake; buffer until the socket is live.
  private outbox: ClientMessage[] = [];
  private closed = false;

  constructor(url: string, handlers: ConnectionHandlers) {
    this.handlers = handlers;
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      for (const message of this.outbox.splice(0)) {
        this.socket.send(JSON.stringify(message));
      }
    });
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        dispatchMessage(this.handlers, event.data);
      }
    });
    this.socket.addEventListener("close", (event) => {
      this.stopPing();
      if (!this.closed) {
        this.reportClosed({ code: event.code, reason: event.reason });
      }
    });
    this.socket.addEventListener("error", () => {
      this.reportClosed({ code: 0, reason: "socket-error" });
    });
    // The relay answers these via its auto-response pair without waking hibernation.
    this.pingTimer = setInterval(() => this.send(PING_MESSAGE), PING_INTERVAL_MS);
  }

  send(message: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else if (this.socket.readyState === WebSocket.CONNECTING) {
      this.outbox.push(message);
    }
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    this.outbox = [];
    this.socket.close();
  }

  // Browsers fire error before close on abnormal failure; downstream fallback
  // logic must run exactly once per socket.
  private reportClosed(info: CloseInfo): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopPing();
    this.handlers.onClose(info);
  }

  private stopPing(): void {
    clearInterval(this.pingTimer);
  }
}
