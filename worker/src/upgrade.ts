import type { ServerMessage } from "../../shared/protocol";

/**
 * Rejections must still complete the WebSocket handshake: the client receives
 * the structured `rejected` message before the close frame carries the code,
 * so both signal paths agree.
 */
export function rejectUpgrade(reason: string, code: number): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  const message: ServerMessage = { t: "rejected", reason };
  server.send(JSON.stringify(message));
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}
