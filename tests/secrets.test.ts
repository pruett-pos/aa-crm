import { test } from "node:test";
import assert from "node:assert/strict";
import { newIntegrationKey, openSecret, sealSecret } from "../src/lib/secrets.ts";

const KEY = newIntegrationKey();

test("a sealed secret opens again, and the stored text never contains it", () => {
  const sealed = sealSecret("refresh-token-abc123", KEY);
  assert.ok(!sealed.includes("refresh-token-abc123"));
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(openSecret(sealed, KEY), "refresh-token-abc123");
});

test("sealing the same secret twice gives different text (a fresh random value each time)", () => {
  assert.notEqual(sealSecret("same", KEY), sealSecret("same", KEY));
});

test("odd secrets round trip: empty, long, unicode", () => {
  for (const s of ["", "x".repeat(5000), "Дана “Миллер” 🙂"]) assert.equal(openSecret(sealSecret(s, KEY), KEY), s);
});

test("the wrong key, or any changed part, refuses to open", () => {
  const sealed = sealSecret("secret", KEY);
  assert.throws(() => openSecret(sealed, newIntegrationKey()), /Unreadable/);
  const [v, iv, tag, ct] = sealed.split(".");
  const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  for (const bad of [[v, flip(iv), tag, ct], [v, iv, flip(tag), ct], [v, iv, tag, flip(ct)], ["v2", iv, tag, ct], [v, iv, tag]]) {
    assert.throws(() => openSecret(bad.join("."), KEY), /Unreadable/);
  }
  assert.throws(() => openSecret("not even close", KEY), /Unreadable/);
  assert.throws(() => openSecret(`${sealed}.extra`, KEY), /Unreadable/);
});

test("a missing or wrong-sized key is refused with a clear message", () => {
  for (const bad of [undefined, "", "   ", "c2hvcnQ=", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64")]) {
    assert.throws(() => sealSecret("x", bad), /INTEGRATION_KEY must be 32 bytes/);
  }
  assert.equal(openSecret(sealSecret("x", `  ${KEY}\n`), KEY), "x");       // stray whitespace around a pasted key is fine
});
