export type QboErrorKind =
  | "auth"          // token refused: an admin has to connect again
  | "network"       // could not reach Intuit
  | "rate_limit"    // 429
  | "server"        // 5xx
  | "duplicate"     // QuickBooks says the name is already used
  | "validation"    // QuickBooks refused the data: a person has to fix a mapping or the data, then press Retry
  | "not_found";

/** Messages carry Intuit's own short reason and an HTTP status, never a token, code or secret. */
export class QboError extends Error {
  kind: QboErrorKind;
  constructor(kind: QboErrorKind, message: string) {
    super(message);
    this.name = "QboError";
    this.kind = kind;
  }
}

/** Worth trying again later on its own. */
export const isRetryable = (k: QboErrorKind) => k === "network" || k === "rate_limit" || k === "server";
