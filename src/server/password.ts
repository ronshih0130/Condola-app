/** Live password rules from the sign-in spec: 8+ characters, letters and numbers, not a common password. */

const COMMON = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "qwertyui",
  "abc12345",
  "iloveyou",
  "iloveyou1",
  "admin123",
  "letmein1",
  "welcome1",
  "passw0rd",
  "changeme",
  "changeme1",
]);

export type PasswordIssue = "length" | "alnum" | "common";

export function passwordIssues(password: string): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.length < 8) issues.push("length");
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) issues.push("alnum");
  if (COMMON.has(password.trim().toLowerCase())) issues.push("common");
  return issues;
}

export function passwordAcceptable(password: string) {
  return passwordIssues(password).length === 0;
}
