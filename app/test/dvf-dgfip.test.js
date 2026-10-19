import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { openDatabase } from "../src/db.js";
import createRepositories from "../src/repositories/index.js";
import createLogger from "../src/lib/logger.js";
import createDvfImportService from "../src/services/dvf-import.service.js";
import { importDgfipStream } from "../src/services/dvf-dgfip.js";
import {
  dgfipInseeCode,
  dgfipIsoDate,
  pickDgfipResource,
  parseBanGeocodeCsv,
  banGeocodeCsv,
  dvfSourceSummary,
  formatYearRanges,
} from "../src/lib/dvf-dgfip.js";
import { readZipEntries, zipEntryStream } from "../src/lib/zip.js";

const HEADER = [
  "Identifiant de document", "Reference document", "1 Articles CGI", "2 Articles CGI",
  "3 Articles CGI", "4 Articles CGI", "5 Articles CGI", "No disposition", "Date mutation",
  "Nature mutation", "Valeur fonciere", "No voie", "B/T/Q", "Type de voie", "Code voie",
  "Voie", "Code postal", "Commune", "Code departement", "Code commune",
  "Prefixe de section", "Section", "No plan", "No Volume", "1er lot",
  "Surface Carrez du 1er lot", "2eme lot", "Surface Carrez du 2eme lot", "3eme lot",
  "Surface Carrez du 3eme lot", "4eme lot", "Surface Carrez du 4eme lot", "5eme lot",
  "Surface Carrez du 5eme lot", "Nombre de lots", "Code type local", "Type local",
  "Identifiant local", "Surface reelle bati", "Nombre pieces principales",
  "Nature culture", "Nature culture speciale", "Surface terrain",
];

function dgfipLine(fields) {
  return HEADER.map((name) => fields[name] ?? "").join("|");
}

const MEXIMIEUX = {
  "No disposition": "000001",
  "Date mutation": "08/01/2026",
  "Nature mutation": "Vente",
  "Valeur fonciere": "130000,00",
  "No voie": "27",
  "Type de voie": "RUE",
  "Voie": "DE GENEVE",
  "Code postal": "1800",
  "Commune": "MEXIMIEUX",
  "Code departement": "01",
  "Code commune": "244",
};

const DGFIP_TEXT = [
  HEADER.join("|"),
  // Appartement + dépendance : une seule vente retenue.
  dgfipLine({ ...MEXIMIEUX, "Type local": "Appartement", "Surface reelle bati": "41" }),
  dgfipLine({ ...MEXIMIEUX, "Type local": "Dépendance", "Surface reelle bati": "0" }),
  // Maison + appartement dans la même mutation : prix ambigu, écartée.
  dgfipLine({ ...MEXIMIEUX, "Date mutation": "09/01/2026", "Valeur fonciere": "400000,00", "Type local": "Maison", "Surface reelle bati": "120" }),
  dgfipLine({ ...MEXIMIEUX, "Date mutation": "09/01/2026", "Valeur fonciere": "400000,00", "Type local": "Appartement", "Surface reelle bati": "60" }),
  // Maison en Guadeloupe (département à trois chiffres), adresse inconnue de la BAN.
  dgfipLine({
    "No disposition": "000001",
    "Date mutation": "15/03/2026",
    "Nature mutation": "Vente",
    "Valeur fonciere": "250000,00",
    "No voie": "3",
    "Type de voie": "CHE",
    "Voie": "DES FLAMBOYANTS",
    "Code departement": "971",
    "Code commune": "101",
    "Type local": "Maison",
    "Surface reelle bati": "100",
  }),
].join("\n");

/** Archive zip d'une seule entrée « deflate », construite à la main. */
function makeZip(name, content) {
  const raw = Buffer.from(content, "utf8");
  const data = deflateRawSync(raw);
  const nameBuf = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

async function streamToString(stream) {
  let out = "";
  for await (const chunk of stream) out += chunk.toString("utf8");
  return out;
}

const BAN_HEADER =
  "id,adresse,citycode,longitude,latitude,result_score,result_type,result_status";

/** Réponse BAN simulée : seule la rue de Genève est reconnue. */
function banResponseFor(csv) {
  const lines = csv.trim().split("\n").slice(1);
  const rows = lines.map((line) => {
    const [id, adresse, citycode] = line.split(",");
    return /GENEVE/.test(adresse)
      ? `${id},${adresse},${citycode},5.194501,45.904161,0.96,housenumber,ok`
      : `${id},${adresse},${citycode},,,,,not-found`;
  });
  return [BAN_HEADER, ...rows].join("\n");
}

test("dgfipInseeCode reconstruit le code INSEE (métropole, Corse, outre-mer)", () => {
  assert.equal(dgfipInseeCode("01", "244"), "01244");
  assert.equal(dgfipInseeCode("1", "4"), "01004");
  assert.equal(dgfipInseeCode("2A", "4"), "2A004");
  assert.equal(dgfipInseeCode("971", "101"), "97101");
  assert.equal(dgfipInseeCode("75", "101"), "75101");
  assert.equal(dgfipInseeCode("", "101"), null);
});

test("dgfipIsoDate convertit JJ/MM/AAAA", () => {
  assert.equal(dgfipIsoDate("08/01/2026"), "2026-01-08");
  assert.equal(dgfipIsoDate("2026-01-08"), null);
});

test("pickDgfipResource trouve l'année, y compris un premier semestre", () => {
  const resources = [
    { title: "Valeurs foncières 2026 - Premier semestre", url: "https://x/2026-s1.zip" },
    { title: "Valeurs foncières 2025", url: "https://x/2025.zip" },
    { title: "Notice descriptive des fichiers de valeurs foncières", url: "https://x/notice.pdf" },
  ];
  assert.deepEqual(pickDgfipResource(resources, 2026), {
    url: "https://x/2026-s1.zip",
    title: "Valeurs foncières 2026 - Premier semestre",
    partial: true,
  });
  assert.equal(pickDgfipResource(resources, 2025).partial, false);
  assert.equal(pickDgfipResource(resources, 2020), null);
});

test("parseBanGeocodeCsv ne garde que les résultats précis et assez sûrs", () => {
  const csv = [
    BAN_HEADER,
    "0,27 RUE DE GENEVE,01244,5.19,45.90,0.96,housenumber,ok",
    "1,RUE X,01244,5.2,45.9,0.3,street,ok",
    "2,LE BOURG,01244,5.2,45.9,0.9,municipality,ok",
    '3,"1, RUE Y",01244,5.21,45.91,0.8,street,ok',
    "4,INCONNUE,01244,,,,,not-found",
  ].join("\n");
  const coords = parseBanGeocodeCsv(csv, { minScore: 0.5 });
  assert.deepEqual([...coords.keys()], ["0", "3"]);
  assert.deepEqual(coords.get("0"), { lat: 45.9, lng: 5.19 });
});

test("banGeocodeCsv protège les virgules et guillemets", () => {
  const csv = banGeocodeCsv([{ id: "0", address: 'RUE "A", B', citycode: "01244" }]);
  assert.equal(csv, 'id,adresse,citycode\n0,"RUE ""A"", B",01244\n');
});

test("readZipEntries et zipEntryStream relisent une archive deflate", async () => {
  const zip = makeZip("ValeursFoncieres-2026-S1.txt", "bonjour|monde\n");
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "ValeursFoncieres-2026-S1.txt");
  assert.equal(await streamToString(zipEntryStream(zip, entries[0])), "bonjour|monde\n");
  assert.throws(() => readZipEntries(Buffer.from("pas un zip, juste du texte")), /zip invalide/);
});

test("importDgfipStream regroupe, nettoie et géocode les ventes", async () => {
  const inserted = [];
  const repo = {
    insertMutationBatch(rows) {
      inserted.push(...rows);
      return rows.length;
    },
  };
  const calls = [];
  const geocode = async (items) => {
    calls.push(items);
    return new Map([[items.find((i) => /GENEVE/.test(i.address)).id, { lat: 45.9, lng: 5.19 }]]);
  };

  const result = await importDgfipStream(Readable.from([DGFIP_TEXT]), repo, {
    geocode,
    batchSize: 1000,
  });

  assert.deepEqual(result, { imported: 2, geocoded: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].map((i) => [i.address, i.citycode]),
    [
      ["27 RUE DE GENEVE", "01244"],
      ["3 CHE DES FLAMBOYANTS", "97101"],
    ]
  );

  const [apartment, house] = inserted;
  assert.equal(apartment.type_local, "apartment");
  assert.equal(apartment.insee_code, "01244");
  assert.equal(apartment.dept_code, "01");
  assert.equal(apartment.year, 2026);
  assert.equal(apartment.mutation_date, "2026-01-08");
  assert.equal(apartment.price, 130000);
  assert.equal(apartment.price_per_m2, 3170.73);
  assert.equal(apartment.lat, 45.9);
  assert.equal(apartment.lng, 5.19);

  assert.equal(house.insee_code, "97101");
  assert.equal(house.dept_code, "971");
  assert.equal(house.lat, null);
});

test("importDgfipStream insère sans coordonnées si le géocodage échoue", async () => {
  const inserted = [];
  const repo = { insertMutationBatch: (rows) => (inserted.push(...rows), rows.length) };
  const errors = [];
  const result = await importDgfipStream(Readable.from([DGFIP_TEXT]), repo, {
    geocode: async () => {
      throw new Error("BAN indisponible");
    },
    batchSize: 1000,
    onGeocodeError: (err) => errors.push(err.message),
  });
  assert.deepEqual(result, { imported: 2, geocoded: 0 });
  assert.deepEqual(errors, ["BAN indisponible"]);
  assert.ok(inserted.every((m) => m.lat == null));
});

test("runImport reprend une année absente de geo-dvf depuis le fichier DGFiP", async () => {
  const db = openDatabase(":memory:");
  const repositories = createRepositories(db);
  const requested = [];
  const fakeFetch = async (url, init = {}) => {
    requested.push(String(url));
    if (String(url).includes("geo-dvf")) {
      return new Response("<Error>NoSuchKey</Error>", { status: 404 });
    }
    if (String(url).includes("/api/1/datasets/")) {
      return Response.json({
        resources: [
          { title: "Valeurs foncières 2026 - Premier semestre", url: "https://static.test/2026-s1.zip" },
        ],
      });
    }
    if (String(url) === "https://static.test/2026-s1.zip") {
      return new Response(makeZip("ValeursFoncieres-2026-S1.txt", DGFIP_TEXT));
    }
    if (String(url).includes("geocodage")) {
      const csv = await init.body.get("data").text();
      assert.equal(init.body.get("citycode"), "citycode");
      return new Response(banResponseFor(csv));
    }
    throw new Error(`URL inattendue : ${url}`);
  };

  const dvf = createDvfImportService({
    repositories,
    logger: createLogger({ level: "silent" }),
    fetch: fakeFetch,
  });
  const jobId = repositories.dvf.createJob({ sourceLabel: "test", yearFrom: 2025, yearTo: 2026 });
  await dvf.runImport(jobId, { yearFrom: 2025, yearTo: 2026, banMinIntervalMs: 0 });

  const job = repositories.dvf.getJob(jobId);
  assert.equal(job.status, "done", job.error);
  assert.equal(job.rows_imported, 2);
  assert.match(job.source_label, /DGFiP 2026 S1/);
  assert.match(job.source_label, /non publiées : 2025/);
  assert.equal(repositories.dvf.countMutations(), 2);
  assert.deepEqual(
    repositories.dvf.communeSeries("01244", "apartment").map((r) => r.year),
    [2026]
  );
  const nearby = repositories.dvf.radiusCandidates(
    "apartment",
    { minLat: 45.8, maxLat: 46, minLng: 5.1, maxLng: 5.3 },
    { yearFrom: 2026 }
  );
  assert.equal(nearby.length, 1);
  assert.ok(requested.some((u) => u.endsWith("/2026/full.csv.gz")));
  db.close();
});

test("dvfSourceSummary décrit les sources importées et les années manquantes", () => {
  assert.equal(formatYearRanges([2016, 2017, 2018, 2020]), "2016–2018, 2020");
  const label = dvfSourceSummary({
    geoDvfYears: [2021, 2022, 2023, 2024, 2025],
    dgfip: [{ year: 2026, partial: true, imported: 3, geocoded: 2 }],
    skippedYears: [2016, 2017, 2018, 2019, 2020],
  });
  assert.equal(
    label,
    "geo-dvf 2021–2025 · DGFiP 2026 S1 (2 ventes géocodées sur 3) · non publiées : 2016–2020"
  );
});
