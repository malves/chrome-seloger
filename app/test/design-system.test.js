import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import request from "supertest";
import { createTestApp, createUser, loginAgent } from "./helpers.js";
import { allDesignTokens } from "../src/lib/design-system.js";
import { ICONS, ICON_GROUPS } from "../src/lib/icons.js";
import { DESIGN_PATTERNS, patternAnchor } from "../src/lib/design-system-patterns.js";
import config from "../src/config.js";

const APP_CSS = readFileSync(new URL("../public/css/app.css", import.meta.url), "utf8");

/** Variables déclarées dans le premier bloc `:root` de app.css. */
function rootTokens(css) {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map();
  for (const match of withoutComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return tokens;
}

function withApp(name, fn) {
  test(name, async (t) => {
    const ctx = createTestApp();
    t.after(() => ctx.close());
    await fn(ctx);
  });
}

test("le catalogue du design system reflète exactement :root de app.css", () => {
  const css = rootTokens(APP_CSS);
  const documented = allDesignTokens();

  assert.ok(css.size > 0, ":root introuvable dans app.css");
  for (const token of documented) {
    assert.equal(css.get(token.name), token.value, `valeur de ${token.name}`);
    assert.ok(token.role, `rôle manquant pour ${token.name}`);
  }
  const names = new Set(documented.map((token) => token.name));
  for (const name of css.keys()) {
    assert.ok(names.has(name), `${name} n'est pas documenté dans lib/design-system.js`);
  }
});

test("chaque pattern a un id unique et une ancre pattern-*", () => {
  const ids = DESIGN_PATTERNS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "ids de patterns dupliqués");
  for (const pattern of DESIGN_PATTERNS) {
    assert.match(patternAnchor(pattern.id), /^pattern-[a-z0-9-]+$/);
    assert.ok(pattern.referenceFile, `referenceFile manquant pour ${pattern.id}`);
    assert.ok(pattern.classes, `classes manquantes pour ${pattern.id}`);
    assert.equal(pattern.hasSpec, true, `hasSpec manquant pour ${pattern.id}`);
  }
});

test("chaque icône du sprite appartient à exactement un groupe du catalogue", () => {
  const grouped = ICON_GROUPS.flatMap((group) => group.names);
  assert.equal(new Set(grouped).size, grouped.length, "icône classée dans deux groupes");
  assert.deepEqual([...grouped].sort(), Object.keys(ICONS).sort());
});

withApp("l'admin consulte le design system", async ({ app, repositories }) => {
  await createUser(repositories, config.adminEmails[0]);
  const agent = await loginAgent(app, config.adminEmails[0]);

  const res = await agent.get("/admin/design-system").expect(200);
  assert.match(res.text, /<h1 class="ds-hero__title">Design system<\/h1>/);
  assert.match(res.text, /\/public\/css\/design-system\.css/);
  assert.match(res.text, /--green-900/);
  assert.match(res.text, /id="ecarts"/);
  assert.match(res.text, /<symbol id="wi-sofa"/, "sprite inclus");
  assert.match(res.text, /<use href="#wi-pin"><\/use>/, "catalogue d'icônes rendu");
  assert.match(res.text, /detail-fav-star-pop/);
  assert.match(res.text, /id="amount-stepper"/);
  assert.match(res.text, /id="date-picker"/);
  assert.match(res.text, /id="formulaires-references"/);
  assert.match(res.text, /amount-stepper__btn--up/);
  assert.match(res.text, /date-range-picker/);
  assert.match(res.text, /id="patterns"/);
  assert.match(res.text, /id="pattern-form-amount-stepper"/);
  assert.match(res.text, /id="pattern-data-table-numeric-admin"/);
  for (const pattern of DESIGN_PATTERNS) {
    assert.match(res.text, new RegExp(`id="${patternAnchor(pattern.id)}"`), pattern.id);
  }
  assert.doesNotMatch(res.text, /<script>/, "aucun script en ligne (CSP)");
});

withApp("le design system est invisible pour un compte non admin", async ({ app, repositories }) => {
  await createUser(repositories, "user@test.local");
  const agent = await loginAgent(app, "user@test.local");
  await agent.get("/admin/design-system").expect(404);
});

withApp("le design system exige une connexion", async ({ app }) => {
  const res = await request(app).get("/admin/design-system");
  assert.ok([302, 404].includes(res.status), `statut inattendu ${res.status}`);
});
