// ============================================
// MONEY ERRORS (issue #178)
// ============================================
//
// Typed errors so callers (and the HTTP layer) can tell "this currency is not
// offered" from "we have no usable rate right now" without parsing messages.
// A quote that cannot be priced FAILS with one of these; it never returns a
// guessed number.

/** The failure kinds of the money module. */
export type MoneyErrorCode =
  /** The code is not a currency the system knows. */
  | "CURRENCY_UNSUPPORTED"
  /** Known, but switched off in `appConfig/currencies`. */
  | "CURRENCY_DISABLED"
  /** No rate has ever been stored (or provider and override both absent). */
  | "RATE_UNAVAILABLE"
  /** A rate exists but is older than the freshness limit. */
  | "RATE_STALE"
  /** An input (amount, rate, reason, ...) failed validation. */
  | "INVALID_INPUT";

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
    /** The currency involved, when there is one. */
    readonly currency?: string
  ) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Type guard that survives module duplication in tests. */
export function isMoneyError(err: unknown): err is MoneyError {
  return err instanceof MoneyError || (err as { name?: string } | null)?.name === "MoneyError";
}
