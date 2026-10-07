import { test } from "node:test";
import assert from "node:assert/strict";
import { describeShape } from "../src/lib/measurements/parse.ts";

test("describeShape: names and numbers are shown, strings only by length", () => {
  const out = describeShape({ address: "12 Oak St", roof: { roof_facets: { area: 2436.6, total: 14 }, pitch: [{ roof_pitch: "6/12", area: 100 }] }, ok: true, none: null });
  assert.ok(!out.includes("Oak"));
  assert.equal(out, "{address:string(9),roof:{roof_facets:{area:2436.6,total:14},pitch:array(1)[{roof_pitch:string(4),area:100}]},ok:true,none:null}");
});

test("describeShape: an array shows its length and first item; empty and deep values stay short", () => {
  assert.equal(describeShape([]), "array(0)[]");
  assert.equal(describeShape([1, 2, 3]), "array(3)[1]");
  assert.equal(describeShape({ a: { b: { c: { d: { e: { f: 1 } } } } } }), "{a:{b:{c:{d:{e:{...}}}}}}");
});
