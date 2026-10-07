import { test } from "node:test";
import assert from "node:assert/strict";
import { oauthTripIsOurs } from "../src/lib/hover/state.ts";

test("hover does not echo state: a callback with only ?code= is accepted when this browser started the trip", () => {
  assert.equal(oauthTripIsOurs("abc123", null), true);
});

test("no cookie means this browser did not start a trip (or it expired): rejected", () => {
  assert.equal(oauthTripIsOurs("", null), false);
  assert.equal(oauthTripIsOurs("", "abc123"), false);
});

test("if a state does come back it must match the cookie", () => {
  assert.equal(oauthTripIsOurs("abc123", "abc123"), true);
  assert.equal(oauthTripIsOurs("abc123", "different"), false);
  assert.equal(oauthTripIsOurs("abc123", ""), false);
});
