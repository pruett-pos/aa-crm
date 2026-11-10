// Structured logging: one JSON object per line on stdout/stderr, which Railway's log search can filter
// (for example `@level:error` or `@event:cron.failed`). Never log tokens, secrets, request bodies or customer details.

const SECRET_KEY = /token|secret|password|authorization|cookie|api[_-]?key|signature/i;
const MAX_STACK = 2000;

/** Removes bearer tokens and database passwords from text (no length limit). */
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[redacted]@");
}

/** Removes anything secret-looking from a value before it is logged. Exported for tests. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (typeof value === "string") return redact(value).slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function describeError(err: unknown): { message: string; name: string; stack?: string; digest?: string; code?: string } {
  if (err instanceof Error) {
    const extra = err as Error & { digest?: unknown; code?: unknown };
    return {
      name: err.name, message: String(scrub(err.message)), stack: err.stack ? String(scrub(err.stack)).slice(0, MAX_STACK) : undefined,
      digest: extra.digest != null ? String(extra.digest) : undefined, code: extra.code != null ? String(extra.code) : undefined,
    };
  }
  return { name: "NonError", message: String(scrub(typeof err === "string" ? err : JSON.stringify(err) ?? "unknown")) };
}

type Fields = Record<string, unknown>;
type Sink = (line: string) => void;
let errorSink: Sink = (l) => console.error(l);
let infoSink: Sink = (l) => console.log(l);

/** Tests swap the sinks. */
export function setLogSinks(sinks: { info?: Sink; error?: Sink }) {
  if (sinks.info) infoSink = sinks.info;
  if (sinks.error) errorSink = sinks.error;
}

export function logInfo(event: string, fields: Fields = {}): void {
  infoSink(JSON.stringify({ level: "info", ts: new Date().toISOString(), event, ...(scrub(fields) as Fields) }));
}

export function logError(event: string, err: unknown, fields: Fields = {}): void {
  errorSink(JSON.stringify({ level: "error", ts: new Date().toISOString(), event, ...(scrub(fields) as Fields), error: describeError(err) }));
}
