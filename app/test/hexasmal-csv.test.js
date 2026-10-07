import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHexasmalCsv,
  parseHexasmalRow,
} from "../src/lib/hexasmal-csv.js";

test("parseHexasmalRow extrait INSEE et code postal", () => {
  const row = parseHexasmalRow([
    "01001",
    "L ABERGEMENT CLEMENCIAT",
    "01400",
    "L ABERGEMENT CLEMENCIAT",
    "",
  ]);
  assert.deepEqual(row, { insee_code: "01001", postal_code: "01400" });
});

test("parseHexasmalCsv ignore l'entête commentée", () => {
  const csv = `#Code_commune_INSEE;Nom;Code_postal;Libelle
01001;L ABERGEMENT CLEMENCIAT;01400;X;
01005;AMBERIEUX EN DOMBES;01330;Y;
`;
  const rows = parseHexasmalCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].insee_code, "01001");
  assert.equal(rows[1].postal_code, "01330");
});

test("parseHexasmalCsv accepte codes Corse", () => {
  const row = parseHexasmalRow(["2A004", "AJACCIO", "20000", "AJACCIO", ""]);
  assert.equal(row.insee_code, "2A004");
  assert.equal(row.postal_code, "20000");
});
