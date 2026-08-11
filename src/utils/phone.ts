/**
 * Canonicalizes a phone number for matching purposes only (never used to
 * overwrite what's stored on Lead/Student — those keep whatever format was
 * originally typed in). Existing data was entered inconsistently
 * ("9876543210", "+919876543210", "09876543210", with spaces/dashes), so
 * matching a device-reported number against Lead.phone/Student.phone has to
 * normalize both sides at query time rather than assuming one canonical
 * format is already in the database.
 *
 * Rule: strip everything but digits, then drop a leading country code (91)
 * or trunk prefix (0) so we're left with the bare 10-digit Indian mobile
 * number, which is what we key matching on.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10) return digits;

  // Anything else (landlines, malformed entries, non-Indian numbers) —
  // return the digits as-is rather than guessing; an exact-digits match is
  // still better than refusing to match at all.
  return digits;
}
