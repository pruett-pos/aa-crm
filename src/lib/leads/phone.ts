/** US phone numbers as 10 digits, or null if it can't be one. "1" country code is dropped. */
export function normalizePhone(input: string): string | null {
  if (/[a-z]/i.test(input)) return null; // a stray letter is a typo, not something to silently clean up
  const digits = input.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{9}$/.test(ten) ? ten : null;
}

/**
 * For the CSR search box: if the text looks like part of a phone number (7+ digits),
 * return the digits to match against the end of stored numbers; otherwise null (search by name/address).
 */
export function phoneSearchDigits(q: string): string | null {
  const digits = q.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);
}
