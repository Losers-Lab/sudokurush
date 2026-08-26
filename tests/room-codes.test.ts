import assert from "node:assert/strict";
import test from "node:test";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, isValidRoomCode } from "../shared/roomCodes.ts";

test("valid codes are exactly LENGTH alphabet characters", () => {
  assert.ok(isValidRoomCode("ABC234"));
  assert.ok(isValidRoomCode("AAAAAA"));
  assert.equal(isValidRoomCode("ABC23"), false);
  assert.equal(isValidRoomCode("ABC2345"), false);
});

test("ambiguous characters are excluded from the alphabet", () => {
  for (const banned of ["I", "L", "O", "0", "1"]) {
    assert.equal(ROOM_CODE_ALPHABET.includes(banned), false, `${banned} must not be in the alphabet`);
  }
});

test("lowercase and punctuation are rejected (exact match)", () => {
  assert.equal(isValidRoomCode("abc234"), false);
  assert.equal(isValidRoomCode("ABC-23"), false);
});
