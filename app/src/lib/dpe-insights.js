/**
 * Lecture grand public d'un enregistrement DPE : un état par partie du
 * logement (toit, murs, fenêtres…) et un bandeau étiquettes + budget.
 */

const GRADES = ["A", "B", "C", "D", "E", "F", "G"];

const DPE_VERDICT = {
  A: "Excellent bilan énergétique : peu de dépenses à prévoir.",
  B: "Bonne performance, au-dessus de la moyenne française.",
  C: "Performance moyenne : quelques améliorations possibles.",
  D: "Énergie à surveiller : les factures peuvent peser.",
  E: "Logement énergivore : des travaux sont à prévoir.",
  F: "Très forte consommation : charges élevées à anticiper.",
  G: "Performance très dégradée : rénovation fortement recommandée.",
};

/** Ordre d'affichage des zones (légende et navigation clavier). */
export const ZONE_IDS = [
  "roof",
  "ventilation",
  "walls",
  "windows",
  "hotWater",
  "heating",
  "floor",
];

const ZONE_LABELS = {
  roof: "Toit et combles",
  ventilation: "Ventilation",
  walls: "Murs",
  windows: "Fenêtres",
  hotWater: "Eau chaude",
  heating: "Chauffage",
  floor: "Sol",
};

const UNKNOWN_DETAIL = "Information absente du diagnostic.";

function isEmpty(value) {
  return value === null || value === undefined || value === "";
}

function mergeRecord(record) {
  const base = { ...(record.raw || {}) };
  for (const [key, value] of Object.entries(record)) {
    if (key === "raw" || key === "imported_at") continue;
    if (!isEmpty(value)) base[key] = value;
  }
  return base;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isApartmentBuilding(data) {
  return normalize(data.type_batiment).includes("appartement");
}

function isCollectiveSystem(data, kind) {
  const keys =
    kind === "heating"
      ? ["type_installation_chauffage", "description_installation_chauffage_n1"]
      : ["type_installation_ecs", "description_installation_ecs_n1"];
  const text = normalize(keys.map((k) => data[k]).filter(Boolean).join(" "));
  return text.includes("collectif") || text.includes("collective");
}

function letterOf(value) {
  const letter = String(value ?? "").trim().toUpperCase();
  return GRADES.includes(letter) ? letter : null;
}

function gradeTone(letter) {
  const i = GRADES.indexOf(letter);
  if (i < 0) return null;
  if (i <= 1) return "good";
  if (i === 2) return "average";
  return "poor";
}

function qualityState(value) {
  const q = normalize(value);
  if (!q) return null;
  if (q.includes("insuffisante")) return "poor";
  if (q.includes("moyenne")) return "average";
  if (q.includes("bonne")) return "good";
  return "average";
}

function toNumber(value) {
  if (isEmpty(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatShortDate(value) {
  const d = parseIsoDate(value);
  if (!d) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

/** Part des pertes de chaleur passant par un poste, en % arrondi. */
function lossShare(data, key) {
  const part = toNumber(data[key]);
  const total = toNumber(data.deperditions_enveloppe);
  if (part == null || !total || total <= 0) return null;
  const pct = Math.round((part / total) * 100);
  return pct > 0 && pct <= 100 ? pct : null;
}

function withLossShare(detail, share) {
  if (share == null) return detail;
  return `${detail} ${share} % des pertes de chaleur passent par là.`;
}

const ISOLATION_TITLES = {
  roof: { good: "Toit bien isolé", average: "Toit moyennement isolé", poor: "Toit mal isolé" },
  walls: { good: "Murs bien isolés", average: "Murs moyennement isolés", poor: "Murs mal isolés" },
  windows: {
    good: "Fenêtres performantes",
    average: "Fenêtres correctes",
    poor: "Fenêtres peu isolantes",
  },
  floor: { good: "Sol bien isolé", average: "Sol moyennement isolé", poor: "Sol mal isolé" },
};

const ISOLATION_DETAILS = {
  good: "Peu de chaleur s'échappe par cette partie du logement.",
  average: "Isolation correcte, mais une amélioration reste possible.",
  poor: "Une part importante de la chaleur s'échappe ici.",
};

const ISOLATION_GOOD_ADVICE = "Bon point : peu de déperditions par cette partie.";

const ISOLATION_ADVICE = {
  roof: {
    average:
      "Renforcer l'isolation des combles (laine de verre ou de roche, ~30 cm) : le chantier le plus rentable.",
    poor: "Isoler les combles perdus (laine soufflée ou déroulée) ferait vite baisser les factures.",
  },
  walls: {
    average:
      "Isoler les murs : par l'extérieur (ITE) pour le confort maximal, ou par l'intérieur (ITI) si l'ITE est impossible.",
    poor: "Isoler les murs par l'extérieur (ITE) idéalement, sinon par l'intérieur (ITI) : fort gain attendu.",
  },
  windows: {
    average:
      "Passer à un double vitrage à isolation renforcée (VIR) isolerait mieux du froid et du bruit.",
    poor: "Remplacer par du double vitrage à isolation renforcée (VIR), voire du triple vitrage.",
  },
  floor: {
    average: "Isoler le plancher bas (panneaux en sous-face du sous-sol ou vide sanitaire) gagnerait en confort.",
    poor: "Isoler le plancher bas (panneaux en sous-face, ou flocage) supprimerait la sensation de sol froid.",
  },
};

const ISOLATION_ADVICE_APARTMENT = {
  roof: {
    average:
      "Dernier étage : isoler le plafond par l'intérieur ; sinon, peu d'action sans travaux sur les parties communes.",
    poor: "Dernier étage : isolation du plafond (ITI) ; sinon demandez si combles ou toiture sont rénovés en copropriété.",
  },
  walls: {
    average:
      "En appartement, l'isolation par l'intérieur (ITI) est la plus courante ; l'ITE passe par un vote copropriété sur les façades.",
    poor: "Priorité : isolation par l'intérieur (ITI) ; sinon renseignez-vous sur une rénovation de façade votée en copropriété.",
  },
  windows: {
    average:
      "Double vitrage VIR (voire triple) ; en façade, un accord de copropriété est souvent nécessaire.",
    poor: "Double vitrage VIR ou triple ; vérifiez le règlement de copropriété pour les fenêtres sur rue ou en façade.",
  },
  floor: {
    average:
      "Peu de marge seule : tapis épais ou sol flottant sur sous-couche isolante ; travaux lourds souvent collectifs.",
    poor: "Sans accès au dessous du lot : tapis, sous-couche isolante ; sinon démarche copro si local technique ou cave commun.",
  },
};

function isolationAdvice(id, state, data) {
  if (state === "good") return ISOLATION_GOOD_ADVICE;
  const table = isApartmentBuilding(data) ? ISOLATION_ADVICE_APARTMENT : ISOLATION_ADVICE;
  return table[id][state];
}

function isolationZone(id, value, share, data) {
  const state = qualityState(value);
  if (!state) return null;
  const detail =
    state === "good"
      ? ISOLATION_DETAILS.good
      : withLossShare(ISOLATION_DETAILS[state], share);
  const advice = isolationAdvice(id, state, data);
  return {
    state,
    title: ISOLATION_TITLES[id][state],
    detail,
    advice,
  };
}

function heatingZone(data) {
  const energy = data.type_energie_principale_chauffage;
  const generator = data.type_generateur_chauffage_principal;
  const text = normalize([energy, generator].filter(Boolean).join(" "));
  if (!text) return null;

  if (text.includes("fioul") || text.includes("charbon")) {
    const apartment = isApartmentBuilding(data);
    const collective = isCollectiveSystem(data, "heating");
    if (apartment && collective) {
      return {
        state: "poor",
        title: "Chauffage au fioul",
        detail: "Chaufferie au fioul en copropriété : énergie fossile en voie de disparition.",
        advice:
          "Le remplacement se décide en AG : réseau de chaleur, gaz ou électricité collective. Renseignez-vous sur le calendrier des travaux.",
      };
    }
    if (apartment) {
      return {
        state: "poor",
        title: "Chauffage au fioul",
        detail: "Chaudière individuelle au fioul : énergie fossile chère et en fin de parcours.",
        advice:
          "Remplacer par une chaudière gaz à condensation ou du chauffage électrique récent ; clim réversible (PAC air/air) seulement avec accord de copropriété.",
      };
    }
    return {
      state: "poor",
      title: "Chauffage au fioul",
      detail: "Énergie fossile chère et polluante ; ces chaudières sont en fin de parcours réglementaire.",
      advice: "Alternatives : pompe à chaleur, chaudière gaz à condensation ou réseau de chaleur.",
    };
  }
  if (text.includes("pompe a chaleur") || /\bpac\b/.test(text)) {
    return {
      state: "good",
      title: "Pompe à chaleur",
      detail: "Chauffage efficace : il restitue plusieurs fois l'énergie électrique qu'il consomme.",
      advice: "Bon point : vérifiez simplement l'âge de l'appareil et son entretien.",
    };
  }
  if (text.includes("reseau de chaleur") || text.includes("reseau de chauffage urbain")) {
    return {
      state: "good",
      title: "Réseau de chaleur",
      detail: "Chauffage collectif mutualisé, souvent moins carboné qu'une chaudière individuelle.",
      advice: "Bon point : coût et entretien gérés à l'échelle de l'immeuble.",
    };
  }
  if (text.includes("bois") || text.includes("granule")) {
    const apartment = isApartmentBuilding(data);
    return {
      state: "good",
      title: "Chauffage au bois",
      detail: "Énergie renouvelable et économique à l'usage.",
      advice: apartment
        ? "Vérifiez le règlement de copropriété (conduit, nuisances) et l'entretien du conduit de fumée."
        : "Vérifiez que l'appareil est récent (bon rendement et faibles émissions).",
    };
  }
  if (text.includes("gaz")) {
    const apartment = isApartmentBuilding(data);
    const collective = isCollectiveSystem(data, "heating");
    if (apartment && collective) {
      return {
        state: "average",
        title: "Chauffage au gaz",
        detail:
          "Souvent chauffage collectif au gaz : courant en copropriété, mais énergie fossile.",
        advice:
          "Vous ne choisissez pas l'installation : demandez les travaux prévus sur la chaufferie en AG. De votre côté, robinets thermostatiques et fenêtres bien isolées limitent la facture.",
      };
    }
    if (apartment) {
      return {
        state: "average",
        title: "Chauffage au gaz",
        detail: "Chaudière individuelle au gaz : courant, mais énergie fossile.",
        advice:
          "Une PAC air/eau est rare en appartement (place, bruit, copro). Priorité : chaudière gaz à condensation récente ; une clim réversible peut convenir si la copropriété l'autorise.",
      };
    }
    return {
      state: "average",
      title: "Chauffage au gaz",
      detail: "Courant et assez économique, mais c'est une énergie fossile.",
      advice: "À terme, une pompe à chaleur air/eau réduirait la facture et l'empreinte carbone.",
    };
  }
  if (text.includes("electri")) {
    if (isApartmentBuilding(data)) {
      return {
        state: "average",
        title: "Chauffage électrique",
        detail:
          "Radiateurs électriques : simples, mais la facture grimpe vite si le logement perd de la chaleur.",
        advice:
          "Une clim réversible (PAC air/air) peut remplacer une partie du chauffage avec accord de copropriété ; sinon isolez les menuiseries et préférez des radiateurs à inertie récents.",
      };
    }
    return {
      state: "average",
      title: "Chauffage électrique",
      detail: "Simple à l'usage, mais coûteux si le logement est mal isolé.",
      advice: "Une pompe à chaleur consomme 2 à 3 fois moins ; à défaut, des radiateurs à inertie récents.",
    };
  }
  return {
    state: "average",
    title: String(energy || generator),
    detail: "Type de chauffage indiqué par le diagnostic.",
    advice: null,
  };
}

function hotWaterZone(data) {
  const text = normalize(
    [data.type_energie_principale_ecs, data.type_installation_ecs]
      .filter(Boolean)
      .join(" ")
  );
  if (!text) return null;

  if (text.includes("fioul") || text.includes("charbon")) {
    const apartment = isApartmentBuilding(data);
    const collective = isCollectiveSystem(data, "ecs");
    if (apartment && collective) {
      return {
        state: "poor",
        title: "Eau chaude au fioul",
        detail: "Production collective au fioul : énergie fossile coûteuse.",
        advice: "Demandez les travaux prévus sur la chaufferie en copropriété.",
      };
    }
    if (apartment) {
      return {
        state: "poor",
        title: "Eau chaude au fioul",
        detail: "Eau chaude au fioul individuelle : énergie fossile coûteuse.",
        advice: "Un chauffe-eau thermodynamique (buanderie ou cellier) est l'alternative la plus courante.",
      };
    }
    return {
      state: "poor",
      title: "Eau chaude au fioul",
      detail: "Eau chaude produite à partir d'une énergie fossile coûteuse.",
      advice: "Alternatives : chauffe-eau thermodynamique, ou chauffe-eau solaire individuel (CESI).",
    };
  }
  if (text.includes("thermodynamique") || text.includes("pompe a chaleur") || text.includes("solaire")) {
    return {
      state: "good",
      title: "Eau chaude économe",
      detail: "Système performant (thermodynamique ou solaire) qui consomme peu.",
      advice: "Bon point : faible coût sur l'eau chaude.",
    };
  }
  if (text.includes("reseau de chaleur")) {
    return {
      state: "good",
      title: "Eau chaude collective",
      detail: "Produite par un réseau de chaleur mutualisé.",
      advice: "Bon point : rien à gérer individuellement.",
    };
  }
  if (text.includes("gaz")) {
    const apartment = isApartmentBuilding(data);
    const collective = isCollectiveSystem(data, "ecs");
    if (apartment && collective) {
      return {
        state: "average",
        title: "Eau chaude au gaz",
        detail: "Production souvent collective au gaz : peu de marge côté lot.",
        advice:
          "Renseignez-vous sur l'état de la chaufferie et les travaux prévus en copropriété.",
      };
    }
    if (apartment) {
      return {
        state: "average",
        title: "Eau chaude au gaz",
        detail: "Chauffe-eau ou chaudière individuelle au gaz : courant, mais fossile.",
        advice:
          "Un chauffe-eau thermodynamique (buanderie ou cellier) divise souvent la conso par 2 à 3.",
      };
    }
    return {
      state: "average",
      title: "Eau chaude au gaz",
      detail: "Solution courante, mais c'est une énergie fossile.",
      advice: "Un chauffe-eau thermodynamique, ou solaire (CESI), réduirait la consommation.",
    };
  }
  if (text.includes("electri")) {
    const apartment = isApartmentBuilding(data);
    const collective = isCollectiveSystem(data, "ecs");
    if (apartment && collective) {
      return {
        state: "average",
        title: "Eau chaude électrique",
        detail: "Production collective ou mixte : le détail dépend de la chaufferie de l'immeuble.",
        advice: "Vérifiez si l'eau chaude est comprise dans les charges et l'état des équipements communs.",
      };
    }
    return {
      state: "average",
      title: "Ballon électrique",
      detail: "Un ballon électrique classique consomme beaucoup pour chauffer l'eau.",
      advice: apartment
        ? "Un chauffe-eau thermodynamique (buanderie, cellier ou local technique) divise souvent la facture par 2 à 3."
        : "Alternative : un chauffe-eau thermodynamique divise la facture d'eau chaude par 2 à 3.",
    };
  }
  return {
    state: "average",
    title: "Eau chaude",
    detail: String(data.type_energie_principale_ecs || data.type_installation_ecs),
    advice: null,
  };
}

function ventilationZone(data) {
  const share = lossShare(data, "deperditions_renouvellement_air");
  const recent = String(data.ventilation_posterieure_2012 ?? "").trim();

  if (share != null && share >= 35) {
    const apartment = isApartmentBuilding(data);
    return {
      state: "poor",
      title: "Renouvellement d'air mal maîtrisé",
      detail: `Une grande part des pertes de chaleur (${share} %) vient de l'air renouvelé.`,
      advice: apartment
        ? "VMC simple flux hygroréglable d'abord ; le double flux est possible mais demande de la place. En copro, la rénovation des extractions collectives peut être nécessaire."
        : "Une VMC double flux récupérerait une partie de cette chaleur.",
    };
  }
  if (recent === "1") {
    return {
      state: "good",
      title: "Ventilation récente",
      detail: withLossShare("Système postérieur à 2012 : l'air se renouvelle sans trop de pertes.", share),
      advice: "Bon point : pensez à nettoyer les bouches régulièrement.",
    };
  }
  if (recent === "0") {
    const apartment = isApartmentBuilding(data);
    return {
      state: "average",
      title: "Ventilation ancienne",
      detail: withLossShare("Système antérieur à 2012 : il peut mal ventiler ou laisser filer la chaleur.", share),
      advice: apartment
        ? "VMC simple flux hygroréglable (souvent la plus réaliste) ; double flux si vous avez la place. Renseignez-vous sur la ventilation des parties communes."
        : "Une VMC simple flux hygroréglable, ou double flux pour récupérer la chaleur de l'air extrait.",
    };
  }
  return null;
}

function buildZones(data) {
  const isApartment = isApartmentBuilding(data);
  const raw = {
    roof: isolationZone(
      "roof",
      data.qualite_isolation_plancher_haut_comble_perdu,
      null,
      data
    ),
    walls: isolationZone(
      "walls",
      data.qualite_isolation_murs || data.qualite_isolation_enveloppe,
      lossShare(data, "deperditions_murs"),
      data
    ),
    windows: isolationZone(
      "windows",
      data.qualite_isolation_menuiseries,
      lossShare(data, "deperditions_baies_vitrees"),
      data
    ),
    floor: isolationZone("floor", data.qualite_isolation_plancher_bas, null, data),
    heating: heatingZone(data),
    hotWater: hotWaterZone(data),
    ventilation: ventilationZone(data),
  };

  return ZONE_IDS.map((id) => {
    const zone = raw[id];
    if (zone) return { id, label: ZONE_LABELS[id], ...zone };
    const notConcerned = isApartment && (id === "roof" || id === "floor");
    return {
      id,
      label: ZONE_LABELS[id],
      state: "unknown",
      title: notConcerned ? "Non concerné ou non renseigné" : "Non renseigné",
      detail: notConcerned
        ? "En appartement, cette partie est souvent mitoyenne d'un autre logement."
        : UNKNOWN_DETAIL,
      advice: notConcerned
        ? null
        : "À vérifier lors de la visite : demandez le détail au vendeur.",
    };
  });
}

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

function budgetFrom(data) {
  const annual = toNumber(data.cout_total_5_usages);
  if (annual == null || annual <= 0) return null;
  let tone = "average";
  if (annual >= 2500) tone = "poor";
  else if (annual <= 900) tone = "good";
  return {
    annual: roundTo(annual, 50),
    monthly: roundTo(annual / 12, 5),
    tone,
  };
}

/**
 * @param {object} record — ligne `dpe_records` hydratée
 * @param {object} [fmt] — helpers de format (euro, number)
 */
export function buildDpeInsights(record, fmt = {}) {
  if (!record) return null;

  const data = mergeRecord(record);
  const dpeLetter = letterOf(data.etiquette_dpe);
  const gesLetter = letterOf(data.etiquette_ges);
  const zones = buildZones(data);
  const budget = budgetFrom(data);
  const consoM2 = toNumber(data.conso_5_usages_par_m2_ep);

  const validUntil = parseIsoDate(data.date_fin_validite_dpe);
  const euro = fmt.euro || ((n) => `${n} €`);
  const number = fmt.number || ((n) => String(n));

  const counts = { good: 0, average: 0, poor: 0, unknown: 0 };
  for (const zone of zones) counts[zone.state] += 1;

  return {
    numeroDpe: data.numero_dpe || record.numero_dpe || null,
    dateEtablissement: formatShortDate(data.date_etablissement_dpe),
    validUntil: formatShortDate(data.date_fin_validite_dpe),
    isExpired: Boolean(validUntil && validUntil < new Date()),
    hero: {
      dpe: dpeLetter ? { letter: dpeLetter, tone: gradeTone(dpeLetter) } : null,
      ges: gesLetter ? { letter: gesLetter, tone: gradeTone(gesLetter) } : null,
      verdict: dpeLetter
        ? DPE_VERDICT[dpeLetter]
        : "Diagnostic officiel trouvé à l'adresse sélectionnée.",
      tone: gradeTone(dpeLetter) || "average",
      budget: budget
        ? {
            ...budget,
            annualLabel: euro(budget.annual),
            monthlyLabel: euro(budget.monthly),
          }
        : null,
      consoLabel:
        consoM2 != null && consoM2 > 0
          ? `${number(Math.round(consoM2))} kWh/m²/an`
          : null,
    },
    zones,
    counts,
  };
}
