/**
 * Human-transcribable room codes for non-Discord play. Ambiguous characters
 * (I/L/O/0/1) are excluded at the alphabet level, so validation is exact-match.
 */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;

const CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function isValidRoomCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}
