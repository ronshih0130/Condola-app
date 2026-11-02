import assert from "node:assert/strict";
import test from "node:test";
import { parseReversal, parseTransfer, transferMinor, validTransferDate } from "./owner-transfer-input";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
test("decimal amounts remain exact within the configured currency scale and bigint range", () => {
  assert.equal(transferMinor("12.3400", 4), "123400");
  assert.equal(transferMinor("9007199254740993", 0), "9007199254740993");
  assert.equal(transferMinor("9223372036854775807", 0), "9223372036854775807");
  for (const value of ["", "0", "-1", "1e3", ".1", "1.", "1.001", "9223372036854775808"]) assert.equal(transferMinor(value, 2), null);
  assert.equal(transferMinor("10.0", 0), null);
  assert.equal(transferMinor("1", 5), null);
});
test("dates and immutable request fields are validated before use", () => {
  assert.equal(validTransferDate("2024-02-29"), true);
  for (const value of ["2023-02-29", "2024-13-01", "0000-01-01", "2024-1-1", ""]) assert.equal(validTransferDate(value), false);
  const input = {requestId:id, propertyId:id, ownerId:id, effectiveDate:"2024-02-29", amount:"1.20", reference:"  note  ",expectedCurrency:"TWD",expectedMinorUnit:2};
  assert.deepEqual(parseTransfer(input,2), {requestId:id, propertyId:id, ownerId:id, effectiveDate:"2024-02-29", amountMinor:"120", reference:"note",expectedCurrency:"TWD",expectedMinorUnit:2});
  assert.equal(parseTransfer({...input, ownerId:"invalid"},2), null);
  assert.equal(parseTransfer({...input, reference:"x".repeat(501)},2), null);
  assert.equal(parseReversal({requestId:id, originalId:id, effectiveDate:"2024-02-29", reason:" "}), null);
  assert.equal(parseReversal({requestId:id, originalId:id, effectiveDate:"2024-02-29", reason:" error "})?.reason, "error");
});
