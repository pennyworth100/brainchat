const CURRENT_ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const LEGACY_ROOM_ID_PATTERN = /^\d{4}$/;

export function isValidRoomId(roomId: string) {
  return (
    CURRENT_ROOM_ID_PATTERN.test(roomId) || LEGACY_ROOM_ID_PATTERN.test(roomId)
  );
}
