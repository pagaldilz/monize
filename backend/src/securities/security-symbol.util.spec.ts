import {
  normalizeSymbol,
  symbolsMatch,
} from "./security-symbol.util";

describe("normalizeSymbol", () => {
  it("uppercases the symbol", () => {
    expect(normalizeSymbol("aapl")).toBe("AAPL");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSymbol("  AAPL  ")).toBe("AAPL");
  });

  it("collapses a dash to a dot", () => {
    expect(normalizeSymbol("BRK-B")).toBe("BRK.B");
  });

  it("collapses a space to a dot", () => {
    expect(normalizeSymbol("BRK B")).toBe("BRK.B");
  });

  it("handles leading/trailing whitespace alongside separators", () => {
    expect(normalizeSymbol(" brk-b ")).toBe("BRK.B");
  });

  it("collapses runs of mixed separators to a single dot", () => {
    expect(normalizeSymbol("ABC-. X")).toBe("ABC.X");
  });

  it("leaves a plain ticker with no separators unchanged (after casing)", () => {
    expect(normalizeSymbol("MSFT")).toBe("MSFT");
  });

  it("handles a real dotted symbol", () => {
    expect(normalizeSymbol("brk.b")).toBe("BRK.B");
  });

  it("returns empty string for a non-string input", () => {
    expect(normalizeSymbol(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for an empty/whitespace-only input", () => {
    expect(normalizeSymbol("   ")).toBe("");
  });

  it("does not touch non-separator punctuation", () => {
    // Characters outside [.-\s] are preserved as-is (subject to uppercasing).
    expect(normalizeSymbol("abc^d")).toBe("ABC^D");
  });
});

describe("symbolsMatch", () => {
  it("treats variant forms of the same instrument as equal", () => {
    expect(symbolsMatch("BRK.B", "brk-b")).toBe(true);
    expect(symbolsMatch("BRK B", "BRK-B")).toBe(true);
    expect(symbolsMatch(" aapl ", "AAPL")).toBe(true);
  });

  it("returns false for genuinely different symbols", () => {
    expect(symbolsMatch("AAPL", "MSFT")).toBe(false);
  });
});
