import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoNationalIdKeys,
  normalizeTaiwanPhoneE164,
  validateSealImageHeader,
  validateTaiwanTaxId,
  validateVendorOnboardingInput,
} from "./vendor-onboarding-rules";

test("validateTaiwanTaxId validates 8-digit tax IDs including leading zeros, 7th-digit-7 rule, and divisor 5/10", () => {
  assert.equal(validateTaiwanTaxId("04595257"), true);
  assert.equal(validateTaiwanTaxId("04595252"), true);
  assert.equal(validateTaiwanTaxId("10458575"), true);
  assert.equal(validateTaiwanTaxId("10458574"), true);
  assert.equal(validateTaiwanTaxId("10458570"), true);
  assert.equal(validateTaiwanTaxId("24536806"), true);
  assert.equal(validateTaiwanTaxId("12345675"), true);
  assert.equal(validateTaiwanTaxId("12345676"), true);
  assert.equal(validateTaiwanTaxId("12345670"), true);

  assert.equal(validateTaiwanTaxId("04595258"), false);
  assert.equal(validateTaiwanTaxId("1234567"), false);
  assert.equal(validateTaiwanTaxId("123456789"), false);
  assert.equal(validateTaiwanTaxId("1234567A"), false);
  assert.equal(validateTaiwanTaxId(""), false);
});

test("normalizeTaiwanPhoneE164 normalizes Taiwan mobile, landline, and +886 numbers to E.164", () => {
  assert.equal(normalizeTaiwanPhoneE164("0912-345-678"), "+886912345678");
  assert.equal(normalizeTaiwanPhoneE164("0912345678"), "+886912345678");
  assert.equal(normalizeTaiwanPhoneE164("+886912345678"), "+886912345678");
  assert.equal(normalizeTaiwanPhoneE164("+886-2-2700-1234"), "+886227001234");
  assert.equal(normalizeTaiwanPhoneE164("(02) 2700-1234 #12"), "+886227001234");
  assert.equal(normalizeTaiwanPhoneE164("04-23456789 ext. 9"), "+886423456789");

  assert.equal(normalizeTaiwanPhoneE164("12345"), null);
  assert.equal(normalizeTaiwanPhoneE164(""), null);
  assert.equal(normalizeTaiwanPhoneE164("abc"), null);
});

test("validateSealImageHeader checks PNG and JPEG magic bytes and enforces maxBytes cap", () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);
  const pngResult = validateSealImageHeader(pngBytes, 1024);
  assert.equal(pngResult.ok, true);
  if (pngResult.ok) {
    assert.equal(pngResult.mimeType, "image/png");
  }

  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const jpegResult = validateSealImageHeader(jpegBytes, 1024);
  assert.equal(jpegResult.ok, true);
  if (jpegResult.ok) {
    assert.equal(jpegResult.mimeType, "image/jpeg");
  }

  const tooBig = validateSealImageHeader(pngBytes, 8);
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) {
    assert.equal(tooBig.error, "seal_file_too_large");
  }

  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const badFormat = validateSealImageHeader(pdfBytes, 1024);
  assert.equal(badFormat.ok, false);
  if (!badFormat.ok) {
    assert.equal(badFormat.error, "invalid_seal_format");
  }
});

test("assertNoNationalIdKeys rejects any key resembling a national ID", () => {
  for (const forbiddenKey of [
    "national_id",
    "nationalId",
    "id_number",
    "idNumber",
    "id_no",
    "身分證",
    "身分證字號",
    "身份證字號",
    "tw_id_card",
  ]) {
    const res = assertNoNationalIdKeys({
      display_name: "王師傅",
      [forbiddenKey]: "A123456789",
    });
    assert.equal(res.ok, false, `Expected key "${forbiddenKey}" to be rejected`);
    if (!res.ok) {
      assert.equal(res.error, "national_id_forbidden");
      assert.equal(res.forbiddenKey, forbiddenKey);
    }
  }
});

test("validateVendorOnboardingInput validates business vs individual profiles and attestation", () => {
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);

  const validBusiness = validateVendorOnboardingInput({
    kind: "business",
    business_name: "安居水電工程行",
    tax_id: "04595257",
    representative_name: "林建宏",
    phone: "02-2700-1234",
    address: "台北市大安區仁愛路四段1號",
    qualification_attested: true,
    seal_bytes: pngBytes,
    service_job_types: ["plumbing", "leak_repair"],
  });
  assert.equal(validBusiness.ok, true);
  if (validBusiness.ok) {
    assert.equal(validBusiness.value.kind, "business");
    assert.equal(validBusiness.value.phone_e164, "+886227001234");
    assert.equal(validBusiness.value.tax_id, "04595257");
  }

  const unattestedBusiness = validateVendorOnboardingInput({
    kind: "business",
    business_name: "安居水電工程行",
    tax_id: "04595257",
    representative_name: "林建宏",
    phone: "02-2700-1234",
    address: "台北市大安區仁愛路四段1號",
    qualification_attested: false,
    seal_bytes: pngBytes,
  });
  assert.equal(unattestedBusiness.ok, false);
  if (!unattestedBusiness.ok) {
    assert.equal(unattestedBusiness.error, "qualification_not_attested");
  }

  const validIndividual = validateVendorOnboardingInput({
    kind: "individual",
    display_name: "陳師傅",
    phone: "0912-345-678",
    service_job_types: ["locksmith"],
  });
  assert.equal(validIndividual.ok, true);
  if (validIndividual.ok) {
    assert.equal(validIndividual.value.kind, "individual");
    assert.equal(validIndividual.value.tax_id, null);
    assert.equal(validIndividual.value.phone_e164, "+886912345678");
  }

  const individualWithNationalId = validateVendorOnboardingInput({
    kind: "individual",
    display_name: "陳師傅",
    phone: "0912-345-678",
    身分證字號: "A123456789",
  });
  assert.equal(individualWithNationalId.ok, false);
  if (!individualWithNationalId.ok) {
    assert.equal(individualWithNationalId.error, "national_id_forbidden");
  }
});
