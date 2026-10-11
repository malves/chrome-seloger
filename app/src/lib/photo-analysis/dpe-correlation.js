/**
 * Croisement photos ⇄ DPE (§45, 76). Calculé à l'affichage, quand un DPE est
 * lié à l'annonce : l'analyse photo, elle, est stockée indépendamment.
 *
 * Entrées : `rooms[].windows` / `rooms[].heating` de l'analyse ; zones
 * `windows` / `heating` de `buildDpeInsights` (état good / average / poor).
 */

const OLD_AGES = new Set(["dated", "very_dated"]);
const RECENT_AGES = new Set(["recent", "relatively_recent"]);

/** Âge apparent dominant parmi les pièces (par confiance pondérée). */
export function dominantApparentAge(rooms, key) {
  const scores = {};
  for (const room of rooms || []) {
    const block = room?.[key];
    if (!block || !block.apparent_age || block.apparent_age === "unknown") continue;
    scores[block.apparent_age] = (scores[block.apparent_age] || 0) + (block.confidence ?? 0.5);
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : "unknown";
}

function windowsCorrelation(photoAge, dpeState, dpeDate) {
  const topic = "windows";
  if (photoAge === "unknown" || !dpeState || dpeState === "unknown") {
    return {
      topic,
      status: "inconclusive",
      text: "Les photos ne permettent pas de confronter l'état des fenêtres au DPE.",
    };
  }
  if (OLD_AGES.has(photoAge) && dpeState === "poor") {
    return {
      topic,
      status: "consistent",
      text: "Les fenêtres visibles semblent anciennes, ce qui est cohérent avec la faible performance des menuiseries indiquée par le DPE. Leur remplacement est probablement pertinent.",
    };
  }
  if (OLD_AGES.has(photoAge) && dpeState === "good") {
    return {
      topic,
      status: "inconclusive",
      text: "Les fenêtres paraissent anciennes sur les photos alors que le DPE juge les menuiseries performantes : à vérifier en visite (le DPE peut porter sur un autre lot ou des fenêtres non photographiées).",
    };
  }
  if (RECENT_AGES.has(photoAge) && dpeState === "poor") {
    return {
      topic,
      status: "possible_post_dpe_renovation",
      text: `Les photos suggèrent des fenêtres récentes alors que le DPE${dpeDate ? ` (établi le ${dpeDate})` : ""} signale des menuiseries peu performantes : elles ont peut-être été remplacées après le diagnostic. À confirmer.`,
    };
  }
  if (RECENT_AGES.has(photoAge) && dpeState === "good") {
    return {
      topic,
      status: "consistent",
      text: "Fenêtres d'aspect récent et menuiseries jugées performantes par le DPE : les deux sources concordent.",
    };
  }
  return {
    topic,
    status: "inconclusive",
    text: "Aucune contradiction nette entre l'aspect des fenêtres et le DPE.",
  };
}

function heatingCorrelation(rooms, dpeZone) {
  const topic = "heating";
  const title = String(dpeZone?.title || "").toLowerCase();
  const equipments = new Set();
  let oldCount = 0;
  for (const room of rooms || []) {
    const h = room?.heating;
    if (!h || h.equipment === "unknown" || h.equipment === "none_visible") continue;
    equipments.add(h.equipment);
    if (OLD_AGES.has(h.apparent_age)) oldCount += 1;
  }
  if (!equipments.size || !title) {
    return {
      topic,
      status: "inconclusive",
      text: "Le type de chauffage n'est pas suffisamment visible sur les photos pour être confronté au DPE.",
    };
  }
  const electricVisible = equipments.has("electric_convector") || equipments.has("electric_radiator");
  const waterVisible = equipments.has("water_radiator");
  const dpeElectric = title.includes("électrique");
  const dpeWater = title.includes("gaz") || title.includes("fioul") || title.includes("réseau") || title.includes("pompe");

  if (electricVisible && dpeElectric) {
    return {
      topic,
      status: "consistent",
      text: oldCount
        ? "Radiateurs électriques visibles, d'apparence ancienne, en cohérence avec le chauffage électrique du DPE : une modernisation des émetteurs peut être pertinente."
        : "Radiateurs électriques visibles, en cohérence avec le chauffage électrique indiqué par le DPE.",
    };
  }
  if (waterVisible && dpeWater) {
    return {
      topic,
      status: "consistent",
      text: "Radiateurs à eau visibles, en cohérence avec le mode de chauffage indiqué par le DPE.",
    };
  }
  if ((electricVisible && dpeWater) || (waterVisible && dpeElectric)) {
    return {
      topic,
      status: "possible_post_dpe_renovation",
      text: "Le type d'émetteurs visible sur les photos ne correspond pas au chauffage décrit par le DPE : installation modifiée après le diagnostic, ou DPE d'un autre lot. À vérifier.",
    };
  }
  return {
    topic,
    status: "inconclusive",
    text: "Aucune contradiction nette entre le chauffage visible et le DPE.",
  };
}

/**
 * @param {object} analysis - résultat stocké de l'analyse photos
 * @param {object|null} dpeInsights - sortie de `buildDpeInsights`
 * @returns {object[]} corrélations `{ topic, status, text }`
 */
export function dpeCorrelations(analysis, dpeInsights) {
  if (!analysis?.rooms?.length || !dpeInsights?.zones) return [];
  const byId = Object.fromEntries(dpeInsights.zones.map((z) => [z.id, z]));
  const out = [];

  const windows = byId.windows;
  if (windows) {
    out.push(
      windowsCorrelation(
        dominantApparentAge(analysis.rooms, "windows"),
        windows.state,
        dpeInsights.dateEtablissement
      )
    );
  }
  const heating = byId.heating;
  if (heating && heating.state !== "unknown") {
    out.push(heatingCorrelation(analysis.rooms, heating));
  }
  return out;
}
