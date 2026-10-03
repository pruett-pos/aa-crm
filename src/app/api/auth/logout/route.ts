import { cookies } from "next/headers";
import { destroySession } from "@/lib/auth/core.ts";
import { getStore, SESSION_COOKIE } from "@/lib/auth/index.ts";

// Safe for any caller: ends the session if there is one.
export async function POST() {
  const jar = await cookies();
  await destroySession(getStore(), jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
