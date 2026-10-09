import multer from "multer";

/** This endpoint accepts only FormData's single `file`, never text fields.
 * fields:0 rejects before append-field can materialize attacker-sized arrays.
 * Multer 2.4 uses inclusive fileSize/parts limits (unlike 1.x).
 */
export function createUploadParser(storage: multer.StorageEngine, maxFileSize: number) {
  return multer({ storage, limits: {
    fileSize: maxFileSize,
    files: 1,
    fields: 0,
    parts: 1,
    fieldNameSize: 100,
  } }).single("file");
}
