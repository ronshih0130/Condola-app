import assert from "node:assert/strict";
import test from "node:test";
import { allowIdUpload, idUploadFieldsFit, idUploadTooLarge, ID_UPLOAD_BODY_CAP } from "./id-upload-guard";

test("an ID upload is refused from Content-Length before the body is read", () => {
  assert.equal(idUploadTooLarge(null), false);
  assert.equal(idUploadTooLarge(String(ID_UPLOAD_BODY_CAP)), false);
  assert.equal(idUploadTooLarge(String(ID_UPLOAD_BODY_CAP + 1)), true);
  assert.equal(idUploadFieldsFit([100, 100]), true);
  assert.equal(idUploadFieldsFit([ID_UPLOAD_BODY_CAP + 1]), false);
});

test("ID uploads are limited per user", () => {
  const user = "rate-limit-user";
  const start = 1_700_000_000_000;
  for (let index = 0; index < 8; index += 1) assert.equal(allowIdUpload(user, start + index), true);
  assert.equal(allowIdUpload(user, start + 9), false);
  assert.equal(allowIdUpload(user, start + 10 * 60 * 1000 + 10), true);
});
