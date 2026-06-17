/**
 * Canonical symbol normalization for securities.
 *
 * The `securities` table enforces uniqueness on `(user_id, symbol)`, but the
 * stored value is a free-form string. Without normalization, callers can
 * quietly create duplicate records for the same instrument using
 * different-but-equivalent forms (e.g. `aapl` vs `AAPL`, or `BRK.B` vs
 * `BRK-B` vs `BRK B`).
 *
 * Normalizing at the service layer — rather than only in the UI or the MCP
 * tool — means every entry point (REST API, MCP tool, internal lookups,
 * imports) agrees on one canonical form. This is forward-only: existing
 * variant-form rows are NOT retroactively merged.
 *
 * Rules:
 *  - Uppercase
 *  - Trim leading/trailing whitespace
 *  - Collapse internal runs of the separator characters `.`, `-`, and
 *    whitespace into a single `.` (the most common ticker form, e.g. `BRK.B`)
 *
 * Examples:
 *   " brk-b "   -> "BRK.B"
 *   "aapl"      -> "AAPL"
 *   "BRK B"     -> "BRK.B"
 *   "ABC-X.Y"   -> "ABC.X.Y"   (adjacent separators of mixed kinds collapse to one)
 */
export function normalizeSymbol(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .toUpperCase()
    .trim()
    .replace(/[.\-\s]+/g, ".");
}

/**
 * Compare two raw symbols for equivalence after normalization. Convenience
 * helper for dedup sites and tests.
 */
export function symbolsMatch(a: string, b: string): boolean {
  return normalizeSymbol(a) === normalizeSymbol(b);
}
