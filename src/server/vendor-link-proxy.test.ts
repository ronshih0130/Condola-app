import assert from "node:assert/strict";
import { test } from "node:test";
import { sniffPhotoMime } from "./repair-rules";

test("proxy content types come only from supported magic bytes", () => {
  assert.equal(sniffPhotoMime(Uint8Array.of(255, 216, 255)), "image/jpeg");
  assert.equal(sniffPhotoMime(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)), "image/png");
  const webp = Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80);
  assert.equal(sniffPhotoMime(webp), "image/webp");
  for (const bytes of [
    new Uint8Array(), Uint8Array.of(255, 216), webp.subarray(0, 11),
    new TextEncoder().encode("GIF89a"), new TextEncoder().encode("<svg></svg>"),
    new TextEncoder().encode("image/jpeg"), new TextEncoder().encode("0000ftypheic"),
  ]) assert.equal(sniffPhotoMime(bytes), null);
  for (let i = 0; i < 8; i++) {
    assert.equal(sniffPhotoMime(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10).subarray(0, i)), null);
  }
});
