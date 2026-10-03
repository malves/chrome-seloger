#!/usr/bin/env node
/**
 * Script de préparation des données (exécuté UNE fois, hors extension).
 *
 * Entrées (placées dans /tmp ou passées en argument) :
 *  - presi.csv : résultats 1er tour présidentielle 2022 par commune
 *                (format long : une ligne par candidat x commune).
 *                Source : data.gouv.fr (Ministère de l'Intérieur).
 *  - taxe.csv  : taux communal de taxe foncière (TFPB) par commune.
 *                Source : Orka.tax d'après DGFiP, Licence Ouverte 2.0.
 *
 * Sortie :
 *  - src/data/communes-data.js : un objet `self.COMMUNES_DATA` indexé par
 *    code INSEE => [gauche%, centre%, droite%, indiceTaxe(1-5)].
 *
 * Usage : node scripts/build-data.js [presi.csv] [taxe.csv]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PRESI = process.argv[2] || "/tmp/presi.csv";
const TAXE = process.argv[3] || "/tmp/taxe.csv";
const OUT = path.join(__dirname, "..", "src", "data", "communes-data.js");

/* ------------------------------------------------------------------ *
 *  Classification politique des 12 candidats (n° de panneau 2022)
 *  Blocs simples gauche / centre / droite (droite inclut l'ext. droite).
 * ------------------------------------------------------------------ */
const BLOC_BY_CANDIDATE = {
  1: "gauche", // ARTHAUD (LO)
  2: "gauche", // ROUSSEL (PCF)
  3: "centre", // MACRON (LREM)
  4: "centre", // LASSALLE (Résistons)
  5: "droite", // LE PEN (RN)
  6: "droite", // ZEMMOUR (Reconquête)
  7: "gauche", // MÉLENCHON (LFI)
  8: "gauche", // HIDALGO (PS)
  9: "gauche", // JADOT (EELV)
  10: "droite", // PÉCRESSE (LR)
  11: "gauche", // POUTOU (NPA)
  12: "droite", // DUPONT-AIGNAN (DLF)
};

/* ------------------------------------------------------------------ *
 *  Construction du code INSEE à partir de dep_code + commune_code
 * ------------------------------------------------------------------ */
function buildInsee(depCode, communeCode) {
  const dep = depCode.trim();
  const com = communeCode.trim();
  // Métropole (01-95) et Corse (2A/2B) : dep 2 car. + commune 3 car.
  if (dep.length === 2) return dep + com.padStart(3, "0");
  // DOM (971-976) : INSEE 5 car. = dep(3) + 2 derniers chiffres de la commune.
  if (dep.length === 3) return dep + com.slice(-2).padStart(2, "0");
  return dep + com;
}

/* ------------------------------------------------------------------ *
 *  1) Taxe foncière : lecture + quintiles -> indice 1..5
 * ------------------------------------------------------------------ */
async function readTaxe() {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(TAXE),
    crlfDelay: Infinity,
  });
  let header = true;
  for await (const raw of rl) {
    const line = raw.replace(/^\uFEFF/, "");
    if (header) {
      header = false;
      continue;
    }
    if (!line.trim()) continue;
    const c = line.split(";");
    const insee = c[0].trim();
    const taux = parseFloat((c[6] || "").replace(",", "."));
    if (!insee || !Number.isFinite(taux)) continue;
    rows.push({ insee, taux });
  }

  // Quintiles sur l'ensemble des taux (5 = plus élevé = "plus cher").
  const sorted = rows.map((r) => r.taux).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const t = [q(0.2), q(0.4), q(0.6), q(0.8)];

  const indexByInsee = new Map();
  for (const r of rows) {
    let idx = 1;
    if (r.taux > t[0]) idx = 2;
    if (r.taux > t[1]) idx = 3;
    if (r.taux > t[2]) idx = 4;
    if (r.taux > t[3]) idx = 5;
    indexByInsee.set(r.insee, idx);
  }
  console.log(
    `Taxe : ${rows.length} communes. Seuils quintiles (%) = ${t
      .map((x) => x.toFixed(2))
      .join(", ")}`
  );
  return indexByInsee;
}

/* ------------------------------------------------------------------ *
 *  2) Présidentielle : agrégation des voix par commune -> blocs %
 * ------------------------------------------------------------------ */
async function readPresi() {
  const rl = readline.createInterface({
    input: fs.createReadStream(PRESI),
    crlfDelay: Infinity,
  });

  const acc = new Map(); // insee -> { gauche, centre, droite }
  let header = true;
  let skippedArr = 0;
  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (!line) continue;
    const c = line.split(",");
    if (c.length < 29) continue;
    const depCode = c[4];
    const communeCode = c[8];
    // Ignore les arrondissements (codes type "123AR01") : on garde l'agrégat.
    if (/AR\d/.test(communeCode)) {
      skippedArr++;
      continue;
    }
    const candNum = parseInt(c[24], 10);
    const voix = parseInt(c[28], 10);
    if (!Number.isFinite(candNum) || !Number.isFinite(voix)) continue;
    const bloc = BLOC_BY_CANDIDATE[candNum];
    if (!bloc) continue;

    const insee = buildInsee(depCode, communeCode);
    let e = acc.get(insee);
    if (!e) {
      e = { gauche: 0, centre: 0, droite: 0 };
      acc.set(insee, e);
    }
    e[bloc] += voix;
  }
  console.log(
    `Présidentielle : ${acc.size} communes (lignes arrondissement ignorées : ${skippedArr}).`
  );
  return acc;
}

/* ------------------------------------------------------------------ *
 *  3) Fusion + écriture
 * ------------------------------------------------------------------ */
async function main() {
  const taxe = await readTaxe();
  const presi = await readPresi();

  const out = {};
  let matched = 0;
  let onlyPresi = 0;
  const unmatchedSamples = [];

  for (const [insee, v] of presi) {
    const total = v.gauche + v.centre + v.droite;
    if (total <= 0) continue;
    const g = Math.round((v.gauche / total) * 100);
    const c = Math.round((v.centre / total) * 100);
    const d = 100 - g - c; // garantit somme = 100
    const tx = taxe.get(insee);
    if (tx == null) {
      onlyPresi++;
      if (unmatchedSamples.length < 10) unmatchedSamples.push(insee);
    } else {
      matched++;
    }
    out[insee] = [g, c, d, tx != null ? tx : 0];
  }

  // Communes présentes seulement dans le fichier taxe (ex. nouvelles communes).
  let onlyTaxe = 0;
  for (const [insee, tx] of taxe) {
    if (!out[insee]) {
      out[insee] = [0, 0, 0, tx];
      onlyTaxe++;
    }
  }

  console.log(
    `Fusion : ${Object.keys(out).length} communes au total. ` +
      `Appariées présidentielle+taxe : ${matched}. ` +
      `Présidentielle seule : ${onlyPresi}. Taxe seule : ${onlyTaxe}.`
  );
  if (unmatchedSamples.length) {
    console.log("Exemples INSEE sans taxe :", unmatchedSamples.join(", "));
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const banner =
    "/**\n" +
    " * Données communales pré-calculées (généré par scripts/build-data.js).\n" +
    " * Format : code INSEE => [gauche%, centre%, droite%, indiceTaxeFonciere(1-5)].\n" +
    " *  - Orientation politique : 1er tour présidentielle 2022 (Ministère de l'Intérieur).\n" +
    " *  - Indice taxe foncière : quintile national du taux communal TFPB (DGFiP via Orka.tax).\n" +
    " *    1 = parmi les taux les plus bas de France, 5 = parmi les plus élevés.\n" +
    " * NE PAS ÉDITER À LA MAIN.\n" +
    " */\n";
  fs.writeFileSync(OUT, banner + "self.COMMUNES_DATA = " + JSON.stringify(out) + ";\n");
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`Écrit ${OUT} (${kb} Ko).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
