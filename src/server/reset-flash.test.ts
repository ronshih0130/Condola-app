import assert from "node:assert/strict";
import test from "node:test";
import { forgotSentLocation, resetFlashCookie, resetFlashDisplay } from "./reset-flash";

test("the reset confirmation keeps the email out of every URL", () => {
  const email = "meiling.zhou@songxin.demo";
  const location = forgotSentLocation();
  assert.equal(location, "/forgot");
  assert.equal(location.includes("?"), false);
  assert.equal(location.includes(email), false);
  assert.equal(location.includes("email="), false);

  const cookie = resetFlashCookie(email);
  assert.equal(cookie.name.includes("email"), false);
  assert.equal(cookie.value, email);
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.path, "/forgot");
  assert.ok(cookie.options.maxAge > 0 && cookie.options.maxAge <= 60);
  assert.equal(cookie.options.path.includes(email), false);

  const shown = resetFlashDisplay(cookie.value);
  assert.equal(shown.email, email);
  assert.equal(shown.clearCookie, true);
  assert.equal(resetFlashDisplay(undefined).email, "");
  assert.equal(resetFlashDisplay("  ").email, "");
});
