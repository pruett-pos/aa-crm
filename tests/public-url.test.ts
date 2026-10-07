import { test } from "node:test";
import assert from "node:assert/strict";
import { publicUrl } from "../src/lib/public-url.ts";

const req = (headers: Record<string, string> = {}) => new Request("https://localhost:8080/api/hover/callback?code=x", { headers });

test("APP_URL wins, so a redirect never points at the internal address", () => {
  assert.equal(publicUrl("/settings/hover?connected=1", req(), { APP_URL: "https://crm.example.com" }).href, "https://crm.example.com/settings/hover?connected=1");
});

test("a trailing slash or path on APP_URL does not double up", () => {
  assert.equal(publicUrl("/login", req(), { APP_URL: "https://crm.example.com/" }).href, "https://crm.example.com/login");
});

test("without APP_URL it uses the host the browser used, from the proxy headers", () => {
  const r = req({ "x-forwarded-host": "aa-crm.up.railway.app", "x-forwarded-proto": "https" });
  assert.equal(publicUrl("/login", r, {}).href, "https://aa-crm.up.railway.app/login");
});

test("with nothing to go on it falls back to the request's own address (local dev)", () => {
  const r = new Request("http://localhost:3000/api/x");
  assert.equal(publicUrl("/login", r, {}).href, "http://localhost:3000/login");
});
