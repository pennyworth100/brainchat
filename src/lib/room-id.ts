const READABLE_ROOM_ID_PATTERN = /^[a-z]{3,5}\d{3}$/i;
const CURRENT_ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const LEGACY_ROOM_ID_PATTERN = /^\d{4}$/;

export function normalizeRoomId(roomId: string) {
  const trimmed = roomId.trim();
  return READABLE_ROOM_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function isValidRoomId(roomId: string) {
  const normalized = normalizeRoomId(roomId);
  return (
    READABLE_ROOM_ID_PATTERN.test(normalized) ||
    CURRENT_ROOM_ID_PATTERN.test(normalized) ||
    LEGACY_ROOM_ID_PATTERN.test(normalized)
  );
}
