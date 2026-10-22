/**
 * Expected seconds for the ID photo submit. Set this from a staging measurement.
 * The wait note is shown only when this is greater than 10.
 */
export const ID_UPLOAD_ESTIMATE_SECONDS = 0;

export function idUploadShowsWaitNote(seconds = ID_UPLOAD_ESTIMATE_SECONDS) {
  return seconds > 10;
}
