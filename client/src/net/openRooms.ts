import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isValidRoomCode } from "../../../shared/roomCodes";

export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) {
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/** Accepts sloppy human input (?room=ab-12cd) and returns a clean code or null. */
export function normalizeJoinCode(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const candidate = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return isValidRoomCode(candidate) ? candidate : null;
}
