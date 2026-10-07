import test from "node:test";
import assert from "node:assert/strict";
import { buildJsonViewHtml, jsonForClipboard } from "../src/lib/json-view.js";

test("buildJsonViewHtml colore les types primitifs", () => {
  const html = buildJsonViewHtml({
    label: "test",
    count: 3,
    ok: true,
    missing: null,
  });
  assert.match(html, /class="jv-key">label/);
  assert.match(html, /class="jv-str">"test"/);
  assert.match(html, /class="jv-num">3/);
  assert.match(html, /class="jv-bool">true/);
  assert.match(html, /class="jv-null">null/);
});

test("jsonForClipboard produit un JSON lisible", () => {
  const text = jsonForClipboard({ a: 1 });
  assert.equal(text, '{\n  "a": 1\n}');
});
