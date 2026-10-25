import { ID_UPLOAD_ESTIMATE_SECONDS } from "./id-upload-estimate";
import { MAX_LONG_EDGE } from "./jpeg-size";

/**
 * Compress on the phone once a staging measurement of the ID submit
 * exceeds this many seconds. Set ID_UPLOAD_ESTIMATE_SECONDS above this
 * after measuring. At 0 the extra resize stays off.
 */
export const ID_COMPRESS_AFTER_SECONDS = 20;

/**
 * Long edge when compression is on. About 2000px keeps an ID readable.
 * Lower this if the measured upload is still too slow. The drawn edge
 * never exceeds the server cap.
 */
export const ID_COMPRESS_LONG_EDGE = 2000;

/** JPEG quality when compression is on. */
export const ID_COMPRESS_JPEG_QUALITY = 0.8;

export function idClientCompresses(seconds = ID_UPLOAD_ESTIMATE_SECONDS, after = ID_COMPRESS_AFTER_SECONDS) {
  return seconds > after;
}

/** Edge actually drawn. A setting above the server cap is clamped so the upload still succeeds. */
export function idCompressLongEdge(longEdge = ID_COMPRESS_LONG_EDGE, cap = MAX_LONG_EDGE) {
  const edge = Math.round(longEdge);
  if (!Number.isFinite(edge) || edge < 1) return cap;
  return Math.min(edge, cap);
}
