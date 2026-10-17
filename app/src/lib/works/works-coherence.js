/**
 * Règles de cohérence du plan des pièces, partagées par le serveur (fiche) et
 * la modale « Pièces et état » : un seul calcul, servi tel quel au navigateur.
 *
 * - état d'une pièce et points à refaire (pièce « à préciser ») ;
 * - travaux repérés hors des pièces du plan (jamais perdus) ;
 * - croisement entre le plan et le DPE lié.
 *
 * N'importe que des modules eux-mêmes servis au navigateur.
 */

/* --------------------------- État des pièces --------------------------- */

/** États qui supposent au moins un point à refaire. */
export const CONDITIONS_NEEDING_WORK = ["average", "renovation_needed", "heavy_renovation_likely"];
const CONDITIONS_WITHOUT_WORK = ["new_or_recently_renovated", "very_good", "good", "not_assessable"];

/** Une pièce est à préciser si son état suppose des travaux et qu'aucun point n'est coché. */
export function roomNeedsReview(room) {
  return CONDITIONS_NEEDING_WORK.includes(room.condition) && !(room.issues || []).length;
}

/**
 * État proposé par l'IA, aligné sur ses propres constats (une seule lecture) :
 * - une pièce « Bon » (ou non évaluée) avec des finitions à reprendre passe à « Moyen » ;
 * - une pièce « Moyen » ou pire sans aucun point relevé n'est appuyée par
 *   rien de concret : elle repasse à « Bon » (`unsupported` garde l'avis initial).
 * Ne s'applique qu'aux états de l'IA : un état choisi par l'utilisateur reste tel quel.
 * @returns {{ condition: string, needsReview: boolean, adjusted: boolean, unsupported: string|null }}
 */
export function reconcileRoomCondition(condition, issues) {
  const list = issues || [];
  if (list.length && CONDITIONS_WITHOUT_WORK.includes(condition)) {
    return { condition: "average", needsReview: false, adjusted: true, unsupported: null };
  }
  if (!list.length && CONDITIONS_NEEDING_WORK.includes(condition)) {
    return { condition: "good", needsReview: false, adjusted: true, unsupported: condition };
  }
  return { condition, needsReview: false, adjusted: false, unsupported: null };
}

/* ------------------------ Travaux hors des pièces ------------------------ */

/**
 * Situe les travaux que l'analyse n'a rattachés à aucune pièce par rapport au
 * plan actuel. Un travail intérieur disparaît dès que ses points sont cochés
 * dans la pièce qui contient désormais sa photo ; les extérieurs restent
 * toujours visibles (hors budget intérieur).
 *
 * @param {object[]} sources - `overview.unplacedWorks` : `{ id, label, kind, photos, issues, reason }`
 * @param {object[]} rooms - pièces du plan
 * @param {(room: object) => string} roomName
 * @returns {object[]} `{ ...source, status: "exterior" | "note" | "unassigned" | "to_check", rooms: [{ id, name }], missingIssues }`
 */
export function placeUnplacedWorks(sources, rooms, roomName) {
  const out = [];
  for (const source of sources || []) {
    if (source.kind === "exterior") {
      out.push({ ...source, status: "exterior", rooms: [], missingIssues: [] });
      continue;
    }
    if (!(source.issues || []).length) {
      out.push({ ...source, status: "note", rooms: [], missingIssues: [] });
      continue;
    }
    const holders = (rooms || []).filter((r) => (r.photos || []).some((u) => (source.photos || []).includes(u)));
    if (!holders.length) {
      out.push({ ...source, status: "unassigned", rooms: [], missingIssues: source.issues.slice() });
      continue;
    }
    const checked = new Set(holders.flatMap((r) => r.issues || []));
    const missing = source.issues.filter((k) => !checked.has(k));
    if (!missing.length) continue;
    out.push({
      ...source,
      status: "to_check",
      rooms: holders.map((r) => ({ id: r.id, name: roomName(r) })),
      missingIssues: missing,
    });
  }
  return out;
}

/* ----------------------------- Plan × DPE ----------------------------- */

const OLD_AGES = ["dated", "very_dated"];
const RECENT_AGES = ["recent", "relatively_recent"];

function anyRoomHas(rooms, keys) {
  return (rooms || []).some((r) => (r.issues || []).some((k) => keys.includes(k)));
}

function globalPlanned(globalItems, key) {
  return (globalItems || []).some((i) => i && i.key === key && i.enabled);
}

function windowsCheck(globalItems, zone, photoSignals, dpeDate) {
  if (!zone || !zone.state || zone.state === "unknown") return null;
  const signal = globalPlanned(globalItems, "windows")
    ? "old"
    : RECENT_AGES.includes(photoSignals?.windowsAge)
      ? "recent"
      : "none";
  const topic = "windows";
  if (signal === "old" && zone.state === "poor") {
    return { topic, status: "consistent", text: "Le remplacement des fenêtres est prévu, ce qui concorde avec la faible performance des menuiseries indiquée par le DPE." };
  }
  if (signal === "old" && zone.state === "good") {
    return { topic, status: "to_check", text: "Le remplacement des fenêtres est prévu alors que le DPE juge les menuiseries performantes. Le diagnostic porte peut-être sur d'autres fenêtres : à vérifier en visite." };
  }
  if (signal === "recent" && zone.state === "poor") {
    return { topic, status: "possible_post_dpe_renovation", text: `Les photos montrent des fenêtres d'aspect récent alors que le DPE${dpeDate ? ` (établi le ${dpeDate})` : ""} signale des menuiseries peu performantes : elles ont peut-être été remplacées après le diagnostic. À confirmer.` };
  }
  if (signal === "recent" && zone.state === "good") {
    return { topic, status: "consistent", text: "Fenêtres d'aspect récent et menuiseries jugées performantes par le DPE : les deux sources concordent." };
  }
  if (signal === "none" && zone.state === "poor") {
    return { topic, status: "to_check", text: "Le DPE juge les menuiseries peu performantes, mais le remplacement des fenêtres n'est pas prévu dans « Général ». Vérifiez le vitrage en visite." };
  }
  return null;
}

function heatingCheck(globalItems, zone, photoSignals) {
  if (!zone || !zone.state || zone.state === "unknown") return null;
  const topic = "heating";
  const title = String(zone.title || "").toLowerCase();
  const equipments = photoSignals?.heatingEquipments || [];
  const electricVisible = equipments.includes("electric_convector") || equipments.includes("electric_radiator");
  const waterVisible = equipments.includes("water_radiator");
  const dpeElectric = title.includes("électrique");
  const dpeWater = ["gaz", "fioul", "réseau", "pompe"].some((w) => title.includes(w));
  const planHeating = globalPlanned(globalItems, "heating");

  if ((electricVisible && dpeWater && !dpeElectric) || (waterVisible && dpeElectric && !dpeWater)) {
    return { topic, status: "possible_post_dpe_renovation", text: "Les émetteurs visibles sur les photos ne correspondent pas au chauffage décrit par le DPE : installation modifiée après le diagnostic, ou DPE d'un autre lot. À vérifier." };
  }
  if (zone.state === "poor") {
    return planHeating
      ? { topic, status: "consistent", text: "La modernisation du chauffage est prévue, en accord avec le DPE qui le juge peu efficace." }
      : { topic, status: "to_check", text: "Le DPE juge le chauffage peu efficace alors que sa modernisation n'est pas prévue : l'équipement visible peut paraître correct alors que le système est énergivore." };
  }
  if ((electricVisible && dpeElectric) || (waterVisible && dpeWater)) {
    return { topic, status: "consistent", text: "Les émetteurs visibles correspondent au mode de chauffage indiqué par le DPE." };
  }
  return null;
}

/**
 * Croisement entre le plan (pièces et logement entier) et le DPE lié.
 * @param {object} params
 * @param {object[]} params.rooms - pièces du plan
 * @param {object[]} [params.globalItems] - chantiers « Logement entier » (`plan.global.items`)
 * @param {{ score: number|null, fromPlan: boolean }} params.health - `computeHomeHealth`
 * @param {{ letter: string|null, zones: object[], date?: string|null }|null} params.dpe
 * @param {{ windowsAge?: string, heatingEquipments?: string[] }} [params.photoSignals] - équipements visibles (analyse)
 * @returns {{ topic: string, status: "consistent" | "to_check" | "possible_post_dpe_renovation", tone: string, title: string, text: string }[]}
 */
export function dpeCoherence({ rooms = [], globalItems = [], health = null, dpe = null, photoSignals = {} }) {
  if (!dpe) return [];
  const zones = {};
  for (const z of dpe.zones || []) zones[z.id] = z;
  const out = [];
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dpe.date || ""));
  const date = iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : dpe.date || null;
  const windows = windowsCheck(globalItems, zones.windows, photoSignals, date);
  if (windows) out.push({ ...windows, title: "Fenêtres et DPE" });
  const heating = heatingCheck(globalItems, zones.heating, photoSignals);
  if (heating) out.push({ ...heating, title: "Chauffage et DPE" });

  const ventilation = zones.ventilation;
  if (
    anyRoomHas(rooms, ["humidity", "mold"]) &&
    !globalPlanned(globalItems, "ventilation") &&
    ventilation &&
    ventilation.state &&
    ventilation.state !== "good" &&
    ventilation.state !== "unknown"
  ) {
    out.push({
      topic: "ventilation",
      status: "to_check",
      title: "Humidité et ventilation",
      text: `Des traces d'humidité sont signalées et le DPE juge la ventilation ${ventilation.state === "poor" ? "insuffisante" : "moyenne"} : une VMC est probablement à prévoir avant de refaire les finitions.`,
      poor: true,
    });
  }
  if (health && health.fromPlan && health.score != null && dpe.letter) {
    if ((dpe.letter === "F" || dpe.letter === "G") && health.score >= 75) {
      out.push({ topic: "label", status: "to_check", title: `Bel intérieur, DPE ${dpe.letter}`, text: "Les pièces paraissent en bon état mais l'étiquette énergie est très basse : la rénovation semble surtout esthétique, l'isolation reste à traiter." });
    }
    if ((dpe.letter === "A" || dpe.letter === "B" || dpe.letter === "C") && health.score < 40) {
      out.push({ topic: "label", status: "to_check", title: "Bonne étiquette, intérieur dégradé", text: `Le DPE ${dpe.letter} est bon mais les pièces demandent des travaux : la performance énergétique ne dit rien de l'état des finitions.` });
    }
  }
  return out.map((c) => {
    const { poor, ...rest } = c;
    return { ...rest, tone: c.status === "consistent" ? "good" : poor ? "poor" : "average" };
  });
}
