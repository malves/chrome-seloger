#!/usr/bin/env node
/**
 * Prépare les prix immobiliers médians au m² par commune (maison / appartement).
 *
 * Entrée : stats_whole_period.csv (dataset « Statistiques DVF », data.gouv.fr,
 *          dérivé des Demandes de Valeurs Foncières de la DGFiP).
 *          Médianes €/m² calculées sur les ~5 dernières années.
 *
 * Sortie : src/data/prices-data.js => self.PRICES_DATA indexé par code INSEE :
 *          [ medianAppartement, medianMaison ]  (entiers €/m², 0 = inconnu).
 *
 * Particularités :
 *  - Paris / Lyon / Marseille : l'agrégat commune est vide dans DVF (données
 *    par arrondissement). On agrège les arrondissements (moyenne des médianes
 *    pondérée par le nombre de ventes) vers le code commune parent.
 *  - On ne retient une médiane que si le nombre de ventes >= MIN_VENTES.
 *
 * Usage : node scripts/build-prices.js [stats_whole_period.csv]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const SRC = process.argv[2] || "/tmp/statsdvf.csv";
const OUT = path.join(__dirname, "..", "src", "data", "prices-data.js");
const MIN_VENTES = 5;

// Arrondissements -> code commune parent (agrégat ville).
function parentCity(code) {
  if (/^751\d{2}$/.test(code)) return "75056"; // Paris
  if (/^6938[1-9]$/.test(code)) return "69123"; // Lyon
  if (/^132\d{2}$/.test(code)) return "13055"; // Marseille
  return null;
}

/** Parseur CSV minimal gérant les champs entre guillemets. */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(SRC),
    crlfDelay: Infinity,
  });

  const out = {}; // insee -> [apptMed, maisonMed]
  // Accumulateurs d'agrégation pour Paris/Lyon/Marseille.
  const agg = {}; // parent -> { apptSum, apptN, maisonSum, maisonN }

  let header = true;
  let communes = 0;
  for await (const raw of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (!raw) continue;
    const c = parseCsvLine(raw);
    if (c.length < 16) continue;
    if (c[3] !== "commune") continue; // echelle_geo

    const insee = c[0].trim();
    const apptN = num(c[4]);
    const apptMed = num(c[6]);
    const maisonN = num(c[7]);
    const maisonMed = num(c[9]);

    const parent = parentCity(insee);
    if (parent) {
      const a = (agg[parent] = agg[parent] || {
        apptSum: 0,
        apptN: 0,
        maisonSum: 0,
        maisonN: 0,
      });
      if (apptMed != null && apptN) {
        a.apptSum += apptMed * apptN;
        a.apptN += apptN;
      }
      if (maisonMed != null && maisonN) {
        a.maisonSum += maisonMed * maisonN;
        a.maisonN += maisonN;
      }
      continue; // l'arrondissement lui-même n'est pas stocké
    }

    const appt = apptMed != null && apptN >= MIN_VENTES ? Math.round(apptMed) : 0;
    const maison =
      maisonMed != null && maisonN >= MIN_VENTES ? Math.round(maisonMed) : 0;
    if (appt || maison) {
      out[insee] = [appt, maison];
      communes++;
    }
  }

  // Villes à arrondissements : moyenne des médianes pondérée par les ventes.
  for (const [parent, a] of Object.entries(agg)) {
    const appt = a.apptN ? Math.round(a.apptSum / a.apptN) : 0;
    const maison = a.maisonN ? Math.round(a.maisonSum / a.maisonN) : 0;
    if (appt || maison) out[parent] = [appt, maison];
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const banner =
    "/**\n" +
    " * Prix immobiliers médians au m² par commune (généré par scripts/build-prices.js).\n" +
    " * Format : code INSEE => [ médianeAppartement, médianeMaison ] en €/m² (0 = inconnu).\n" +
    " * Source : Statistiques DVF (data.gouv.fr), d'après les Demandes de Valeurs\n" +
    " * Foncières de la DGFiP — médianes sur ~5 ans. NE PAS ÉDITER À LA MAIN.\n" +
    " */\n";
  fs.writeFileSync(
    OUT,
    banner + "self.PRICES_DATA = " + JSON.stringify(out) + ";\n"
  );
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(
    `Communes avec prix : ${communes} (+${Object.keys(agg).length} villes agrégées). ` +
      `Total : ${Object.keys(out).length}. Écrit ${OUT} (${kb} Ko).`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
