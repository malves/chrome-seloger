import test from "node:test";
import assert from "node:assert/strict";
import { parseFloorFromText, floorFromDpeRaw } from "../src/lib/dpe-floor.js";

test("parseFloorFromText : formes « étage » en texte libre", () => {
  assert.equal(parseFloorFromText("7ème étage"), 7);
  assert.equal(parseFloorFromText("4ème étage à droite de l'ascenseur"), 4);
  assert.equal(parseFloorFromText("1er étage"), 1);
  assert.equal(parseFloorFromText("Étage 3"), 3);
  assert.equal(parseFloorFromText("étage n°2"), 2);
  assert.equal(parseFloorFromText("Étage 7/7"), 7);
  assert.equal(parseFloorFromText("7/7"), 7);
  assert.equal(parseFloorFromText("Etage 5"), 5);
  assert.equal(parseFloorFromText("Etage : 2ème B2 F/M"), 2);
  assert.equal(parseFloorFromText("Etage : 2"), 2);
  assert.equal(parseFloorFromText("Etage 6ème"), 6);
  assert.equal(parseFloorFromText("6ème étage"), 6);
});

test("parseFloorFromText : entier isolé", () => {
  assert.equal(parseFloorFromText("4"), 4);
  assert.equal(parseFloorFromText("2 gauche"), 2);
});

test("parseFloorFromText : rez-de-chaussée et sous-sol", () => {
  assert.equal(parseFloorFromText("RDC"), 0);
  assert.equal(parseFloorFromText("rez-de-chaussée"), 0);
  assert.equal(parseFloorFromText("Rez de chaussée gauche"), 0);
  assert.equal(parseFloorFromText("sous-sol"), -1);
});

test("parseFloorFromText : ordinaux en toutes lettres", () => {
  assert.equal(parseFloorFromText("premier étage"), 1);
  assert.equal(parseFloorFromText("Troisième étage"), 3);
});

test("parseFloorFromText : valeur numérique déjà structurée", () => {
  assert.equal(parseFloorFromText(5), 5);
  assert.equal(parseFloorFromText(0), 0);
});

test("floorFromDpeRaw : structuré d'abord, complément si structuré absent ou à 0", () => {
  assert.equal(
    floorFromDpeRaw({
      numero_etage_appartement: 3,
      complement_adresse_logement: "7ème étage",
    }),
    3
  );
  assert.equal(
    floorFromDpeRaw({
      numero_etage_appartement: 0,
      complement_adresse_logement: "7ème étage",
    }),
    7
  );
  assert.equal(
    floorFromDpeRaw({
      numero_etage_appartement: 3,
      complement_adresse_logement: null,
    }),
    3
  );
  assert.equal(
    floorFromDpeRaw({
      numero_etage_appartement: 0,
      complement_adresse_logement: "RDC HAUT",
    }),
    0
  );
  assert.equal(
    floorFromDpeRaw({
      numero_etage_appartement: 0,
      complement_adresse_logement: null,
    }),
    0
  );
});

test("parseFloorFromText : indéterminé renvoie null", () => {
  assert.equal(parseFloorFromText(""), null);
  assert.equal(parseFloorFromText(null), null);
  assert.equal(parseFloorFromText(undefined), null);
  assert.equal(parseFloorFromText("à gauche en sortant"), null);
});
