/**
 * Affirmations de l'annonce confrontées aux photos : vérification du sujet.
 *
 * « Petit immeuble entièrement rénové » parle de l'immeuble, pas du
 * logement : des photos de l'intérieur ne peuvent ni le confirmer ni le
 * contredire. Le modèle se trompe parfois de sujet ; on relit donc la phrase
 * d'origine de l'annonce et on ne garde un verdict que s'il s'appuie sur des
 * photos du bon sujet.
 */

/** Minuscules, sans accents ni apostrophes typographiques, espaces réduits. */
function fold(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/[«»"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Noms qui fixent le sujet d'une affirmation (texte déjà « plié »). */
const SUBJECT_NOUNS = [
  [
    "building",
    /\b(?:immeubles?|residences?|coproprietes?|batiments?|parties communes|facades?|cage d'escaliers?|ascenseurs?|toitures?|hall d'entree de l'immeuble)\b/g,
  ],
  [
    "dwelling",
    /\b(?:appartements?|logements?|(?:le|ce|du|votre|notre) bien|studios?|duplex|triplex|lofts?|maisons?|pieces?|sejours?|salons?|cuisines?|salles? de bains?|salles? d'eau|chambres?|interieur)\b/g,
  ],
  ["surroundings", /\b(?:quartiers?|rues?|avenues?|boulevards?|environnement|secteur|village|ville)\b/g],
];

/** Tous les noms-sujets d'un texte, avec leur position. */
function subjectNouns(text) {
  const found = [];
  for (const [subject, pattern] of SUBJECT_NOUNS) {
    for (const m of text.matchAll(pattern)) found.push({ subject, index: m.index });
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Sujet d'une affirmation d'après le texte de l'annonce, ou `null` si on ne
 * peut pas trancher. Le nom le plus proche AVANT l'affirmation, dans la même
 * phrase, l'emporte : « appartement rénové dans un immeuble ancien » → logement.
 */
export function subjectFromDescription(claim, description) {
  const c = fold(claim);
  if (!c) return null;

  const inClaim = subjectNouns(c);
  if (inClaim.length) return inClaim[0].subject;

  const d = fold(description);
  let from = d.indexOf(c);
  while (from !== -1) {
    const before = d.slice(0, from);
    const sentenceStart = Math.max(...[".", "!", "?", ";", "\n"].map((p) => before.lastIndexOf(p))) + 1;
    const nouns = subjectNouns(before.slice(sentenceStart));
    if (nouns.length) return nouns[nouns.length - 1].subject;
    from = d.indexOf(c, from + c.length);
  }
  return null;
}

/**
 * Sujet retenu : le texte de l'annonce prime sur le modèle quand il est
 * explicite. Pour une maison, le bâtiment EST le logement.
 */
export function resolveClaimSubject(claim, description, propertyType) {
  const subject = subjectFromDescription(claim.claim, description) || claim.subject || "unclear";
  if (propertyType === "house" && subject === "building") return "dwelling";
  return subject;
}

const SUBJECT_PHRASES = {
  building: "l'immeuble",
  surroundings: "l'environnement du bien",
  dwelling: "le logement",
};

/**
 * Applique la vérification de sujet aux affirmations normalisées.
 * @param {object[]} claims - `description_contradictions` de la synthèse
 * @param {{ records: object[], description?: string, propertyType?: string|null }} context
 */
export function scopeClaims(claims, { records, description = "", propertyType = null }) {
  const byId = new Map((records || []).map((r) => [r.id, r]));
  return (claims || []).map((claim) => {
    const subject = resolveClaimSubject(claim, description, propertyType);
    const evidence = (claim.image_ids || []).map((id) => byId.get(id)).filter(Boolean);

    let relevant = evidence;
    if (subject === "building" || subject === "surroundings") {
      relevant = evidence.filter((r) => r.exterior_kind);
    } else if (subject === "dwelling" && propertyType !== "house") {
      relevant = evidence.filter((r) => !r.exterior_kind);
    }

    const verdict = claim.status !== "not_verifiable";
    if (!verdict || subject === "unclear") return { ...claim, subject };
    // Sans photo citée, un verdict sur le logement reste possible (fiches) ; pas sur l'immeuble.
    const needsOwnPhotos = subject !== "dwelling" || evidence.length > 0;
    if (relevant.length === evidence.length && (relevant.length || !needsOwnPhotos)) {
      return { ...claim, subject };
    }
    if (relevant.length) {
      return { ...claim, subject, image_ids: relevant.map((r) => r.id) };
    }
    return {
      ...claim,
      subject,
      status: "not_verifiable",
      model_status: claim.status,
      image_ids: [],
      reason: `L'affirmation porte sur ${SUBJECT_PHRASES[subject]} : les photos disponibles ne montrent pas ${SUBJECT_PHRASES[subject]} et ne permettent pas de la vérifier.`,
      scope_adjusted: true,
    };
  });
}
