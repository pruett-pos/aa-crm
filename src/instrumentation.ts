// Runs once when the server starts. Next calls onRequestError for every unhandled server error (pages, routes, actions),
// and we write it as one JSON log line. Only the path (no query string) and method are logged: query strings can hold
// addresses or names.
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { logError } = await import("./lib/ops/log.ts");
  logError("request.error", err, {
    method: request.method,
    path: request.path.split("?")[0],
    routePath: context.routePath,
    routeType: context.routeType,
    renderSource: context.renderSource,
  });
};
