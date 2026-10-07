import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";

test("postalInsee resolveInsee — un seul candidat", async () => {
  const db = openDatabase(":memory:");
  const repositories = createRepositories(db);
  repositories.postalInsee.replaceAll([
    { postal_code: "78120", insee_code: "78517" },
  ]);
  const code = await repositories.postalInsee.resolveInsee("78120", "Rambouillet");
  assert.equal(code, "78517");
  db.close();
});

test("postalInsee resolveInsee — désambiguïsation par ville", async () => {
  const db = openDatabase(":memory:");
  const repositories = createRepositories(db);
  repositories.postalInsee.replaceAll([
    { postal_code: "01500", insee_code: "01004" },
    { postal_code: "01500", insee_code: "01007" },
  ]);
  const fetchJson = async (url) => {
    if (url.includes("01004")) return { code: "01004", nom: "AMBERIEU EN BUGEY", population: 15000 };
    if (url.includes("01007")) return { code: "01007", nom: "AMBRONAY", population: 2000 };
    return null;
  };
  const code = await repositories.postalInsee.resolveInsee("01500", "Ambronay", {
    fetchJson,
  });
  assert.equal(code, "01007");
  db.close();
});

test("postalInsee listBrowse filtre et pagine", () => {
  const db = openDatabase(":memory:");
  const repositories = createRepositories(db);
  repositories.postalInsee.replaceAll([
    { postal_code: "78120", insee_code: "78517" },
    { postal_code: "75001", insee_code: "75101" },
    { postal_code: "75002", insee_code: "75102" },
  ]);
  assert.equal(repositories.postalInsee.countBrowse({ q: "781" }), 1);
  assert.equal(repositories.postalInsee.countBrowse({ q: "75" }), 2);
  const page = repositories.postalInsee.listBrowse({ limit: 1, offset: 0 });
  assert.equal(page.length, 1);
  assert.equal(page[0].postal_code, "75001");
  db.close();
});
