import { maxJpegBase64Chars } from "@/lib/jpeg-size";

/** Three capped JPEGs plus the small form fields around them. */
export const ID_UPLOAD_BODY_CAP = maxJpegBase64Chars() * 3 + 64 * 1024;

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map<string, number[]>();

/** True when Content-Length is present and already over the ID upload cap. */
export function idUploadTooLarge(contentLength: string | null) {
  if (!contentLength) return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > ID_UPLOAD_BODY_CAP;
}

/** True when the form fields, measured before base64 decode, fit the cap. */
export function idUploadFieldsFit(lengths: number[]) {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return total <= ID_UPLOAD_BODY_CAP && lengths.every((length) => length <= maxJpegBase64Chars() + 64);
}

/**
 * Sliding window per user. In-memory on purpose: one isolate, no extra service.
 * Returns false when this user has already submitted too many times.
 */
export function allowIdUpload(userId: string, now = Date.now()) {
  const recent = (attempts.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(userId, recent);
    return false;
  }
  recent.push(now);
  attempts.set(userId, recent);
  return true;
}
