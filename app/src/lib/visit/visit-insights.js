/**
 * Bilan de la fiche de visite : moteur pur, partagé entre le serveur et le
 * navigateur (servi tel quel sous /public/js/visit-insights.js, donc aucun
 * import Node ici).
 *
 * À partir des items de la fiche (catalogue + valeurs connues) et des réponses,
 * il évalue les signaux déclaratifs des questions puis en déduit : alertes,
 * corrections de l'annonce, points à demander, levier de négociation, coûts
 * annuels cachés, budget travaux probable, verdict et phase.
 *
 * Réponse : { response: "yes"|"no"|"unknown"|null, value: any, answeredAt }
 *   - yesno           : response yes/no
 *   - confirm_number  : yes = valeur connue confirmée, no = corrigée (value)
 *   - confirm_letter  : idem, value = lettre
 *   - number/scale    : value numérique
 *   - choice/text     : value chaîne
 *   - "unknown"       : « je demanderai » (point à poser)
 */

export const LEVER_LABELS = ["Faible", "Modéré", "Bon", "Fort", "Très fort"];

const TONE_RANK = { ok: 0, info: 1, warn: 2, danger: 3 };

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function isConfirm(item) {
  const t = item && item.input && item.input.type;
  return t === "confirm_number" || t === "confirm_yesno" || t === "confirm_letter";
}

/**
 * Afficher une question conditionnelle ? `showWhen: { questionId, values: [...] }`
 * `values` : valeur d'un choice, ou `yes` / `no` pour un parent yesno, ou `__other__` si choice « Autre ».
 */
export function questionVisible(item, answers) {
  const rule = item && item.showWhen;
  if (!rule || !rule.questionId) return true;
  const parent = answers && answers[rule.questionId];
  if (!parent || parent.response === "unknown") return false;
  const values = Array.isArray(rule.values) ? rule.values : [];
  if (!values.length) return true;
  if (parent.response === "yes" && values.includes("yes")) return true;
  if (parent.response === "no" && values.includes("no")) return true;
  if (parent.response === "other") {
    return values.includes("other") || values.includes("__other__");
  }
  const picked = parent.value;
  if (picked === null || picked === undefined || picked === "") return false;
  return values.includes(String(picked));
}

/** Une réponse compte-t-elle comme « répondue » (hors « je demanderai ») ? */
export function isAnswered(item, answer) {
  if (!answer) return false;
  if (answer.response === "unknown") return false;
  const hasValue = answer.value !== null && answer.value !== undefined && answer.value !== "";
  const inputType = item && item.input && item.input.type;
  if (inputType === "count_pair") {
    if (!answer.value || typeof answer.value !== "object") return false;
    const rows = item.input.rows || [];
    return rows.every((row) => {
      const n = toNumber(answer.value[row.key]);
      return n !== null && n >= 0;
    });
  }
  if (answer.response === "yes") {
    if (inputType === "yesno_number") return hasValue;
    return true;
  }
  // « À corriger » sans valeur saisie n'est pas encore une réponse.
  if (answer.response === "no") return isConfirm(item) ? hasValue : true;
  return hasValue;
}

export function isUnknown(answer) {
  return Boolean(answer && answer.response === "unknown");
}

/** Valeur effective portée par la réponse (valeur connue si confirmée). */
export function effectiveValue(item, answer) {
  if (!answer) return null;
  if (isConfirm(item)) {
    if (answer.response === "yes") return item.known ? item.value : answer.value ?? null;
    if (answer.response === "no") return answer.value ?? null;
    return null;
  }
  return answer.value ?? null;
}

/** La réponse corrige-t-elle une valeur connue de l'annonce ? */
export function isCorrection(item, answer) {
  if (!answer || !item || !item.field) return false;
  if (isConfirm(item)) {
    if (answer.response !== "no") return false;
    if (answer.value === null || answer.value === undefined || answer.value === "") return false;
    if (!item.known) return true;
    return String(answer.value).toUpperCase() !== String(item.value).toUpperCase();
  }
  if (answer.value === null || answer.value === undefined || answer.value === "") return false;
  if (!item.known) return true;
  return String(answer.value).toLowerCase() !== String(item.value).toLowerCase();
}

/** Évalue une condition `when` d'un signal. */
export function matchesWhen(when, item, answer) {
  if (!answer) return false;
  const [kind, arg] = String(when).split(":");
  const value = effectiveValue(item, answer);
  switch (kind) {
    case "yes":
    case "no":
    case "unknown":
      return answer.response === kind;
    case "answered":
      return isAnswered(item, answer);
    case "corrected":
      return isCorrection(item, answer);
    case "value": {
      if (value === null || value === undefined) return false;
      const wanted = String(arg || "").split(",").map((s) => s.trim().toLowerCase());
      return wanted.includes(String(value).trim().toLowerCase());
    }
    case "gte": {
      const n = toNumber(value);
      return n !== null && n >= Number(arg);
    }
    case "count_gte": {
      const parts = String(arg || "").split(":");
      const key = parts[0];
      const min = Number(parts[1] ?? 1);
      const obj = answer.value;
      if (!obj || typeof obj !== "object" || !key) return false;
      const n = toNumber(obj[key]);
      return n !== null && n >= min;
    }
    case "lte": {
      const n = toNumber(value);
      return n !== null && n <= Number(arg);
    }
    case "below_pct": {
      if (!isCorrection(item, answer) || !item.known) return false;
      const known = toNumber(item.value);
      const n = toNumber(answer.value);
      if (known === null || n === null || known <= 0) return false;
      return ((known - n) / known) * 100 >= Number(arg);
    }
    default:
      return false;
  }
}

/** Signaux déclenchés par la réponse à un item. */
export function triggeredSignals(item, answer) {
  if (!item || !Array.isArray(item.signals) || !answer) return [];
  if (answer.response === "unknown") return [];
  return item.signals.filter((sig) => matchesWhen(sig.when, item, answer));
}

/** Note à afficher sous la question : le signal le plus grave déclenché. */
export function noteFor(item, answer) {
  if (isUnknown(answer)) {
    return { tone: "muted", text: "Noté : à demander pendant la visite. Retrouvez la liste dans le bilan." };
  }
  const sigs = triggeredSignals(item, answer);
  if (!sigs.length) return null;
  return sigs.slice().sort((a, b) => (TONE_RANK[b.tone] || 0) - (TONE_RANK[a.tone] || 0))[0];
}

function leverLevel(score) {
  if (score <= 0) return 0;
  if (score <= 2) return 1;
  if (score <= 5) return 2;
  if (score <= 8) return 3;
  return 4;
}

/**
 * @param {object} args
 * @param {Array} args.items items de la fiche (toutes sections confondues)
 * @param {Record<string,object>} args.answers réponses par id de question
 * @param {object} [args.market] { daysOnMarket, priceDrops, priceDelta, firstPrice, lastPrice }
 * @param {object} [args.listing] { price, surface }
 */
export function computeInsights({ items = [], answers = {}, market = {}, listing = {} }) {
  const alerts = [];
  const corrections = [];
  const todo = [];
  const works = [];
  const leverReasons = [];
  let leverScore = 0;

  let answered = 0;
  let essentials = 0;
  let essentialsAnswered = 0;
  let discover = 0;
  let confirm = 0;
  let positives = 0;

  const effective = {};

  for (const item of items) {
    if (!questionVisible(item, answers)) continue;
    const answer = answers[item.id] || null;
    if (item.known) confirm += 1;
    else discover += 1;
    if (item.essential) essentials += 1;

    if (isUnknown(answer)) {
      todo.push({ qid: item.id, question: item.question, section: item.section, theme: item.theme });
      continue;
    }
    if (!isAnswered(item, answer)) continue;

    answered += 1;
    if (item.essential) essentialsAnswered += 1;
    if (item.field) effective[item.field] = effectiveValue(item, answer);

    if (isCorrection(item, answer)) {
      corrections.push({
        qid: item.id,
        field: item.field,
        question: item.question,
        from: item.known ? item.value : null,
        to: answer.value,
        unit: item.unit || null,
      });
    }

    for (const sig of triggeredSignals(item, answer)) {
      if (sig.tone === "ok") positives += 1;
      if (sig.tone === "warn" || sig.tone === "danger") {
        alerts.push({ qid: item.id, tone: sig.tone, text: sig.text, question: item.question, theme: item.theme });
      }
      if (Array.isArray(sig.cost) && sig.cost.length === 2) {
        let mult = 1;
        if (sig.countFrom && answer.value && typeof answer.value === "object") {
          const c = toNumber(answer.value[sig.countFrom]);
          mult = c !== null && c > 0 ? c : 0;
        }
        if (mult > 0) {
          works.push({
            qid: item.id,
            question: item.question,
            min: (Number(sig.cost[0]) || 0) * mult,
            max: (Number(sig.cost[1]) || 0) * mult,
          });
        }
      }
      if (sig.lever) {
        leverScore += Number(sig.lever) || 0;
        leverReasons.push({ qid: item.id, text: sig.text, points: Number(sig.lever) || 0 });
      }
    }
  }

  /* Levier issu des données de marché (durée de vente, baisses). */
  const days = toNumber(market.daysOnMarket);
  if (days !== null && days >= 90) {
    const pts = days >= 180 ? 3 : 2;
    leverScore += pts;
    leverReasons.push({
      qid: null,
      text: `Suivi depuis ${Math.floor(days)} jours : le bien ne part pas au prix affiché.`,
      points: pts,
    });
  }
  const drops = toNumber(market.priceDrops) || 0;
  if (drops > 0) {
    const pts = Math.min(3, drops);
    leverScore += pts;
    leverReasons.push({
      qid: null,
      text: drops > 1 ? `Le prix a déjà baissé ${drops} fois.` : "Le prix a déjà baissé une fois.",
      points: pts,
    });
  }

  alerts.sort((a, b) => (TONE_RANK[b.tone] || 0) - (TONE_RANK[a.tone] || 0));
  const dangers = alerts.filter((a) => a.tone === "danger").length;
  const warns = alerts.length - dangers;

  /* Coûts annuels cachés (hors crédit). */
  const charges = toNumber(effective.charges_copro);
  const taxe = toNumber(effective.taxe_fonciere);
  const energy = toNumber(answers.energy_bills && answers.energy_bills.value);
  const annualParts = [charges, taxe, energy].filter((n) => n !== null && n > 0);
  const annualTotal = annualParts.reduce((s, n) => s + n, 0);

  const worksMin = works.reduce((s, w) => s + w.min, 0);
  const worksMax = works.reduce((s, w) => s + w.max, 0);

  /* Phase et verdict. */
  const decision = answers.decision && answers.decision.value;
  let phase = "preparation";
  if (answered > 0) phase = "visite";
  if (answered > 0 && (decision || (essentials > 0 && essentialsAnswered === essentials))) phase = "terminee";

  let verdict;
  const essentialsLeft = essentials - essentialsAnswered;
  if (answered === 0) {
    verdict = {
      tone: "muted",
      title: "Prêt pour la visite",
      text: "Commencez par les questions à poser avant de partir : elles cadrent la négociation.",
    };
  } else if (dangers > 0) {
    verdict = {
      tone: "danger",
      title: dangers > 1 ? `${dangers} points bloquants` : "Un point bloquant",
      text: "À éclaircir, devis à l'appui, avant toute offre écrite.",
    };
  } else if (warns >= 3) {
    verdict = {
      tone: "warn",
      title: `${warns} points à négocier`,
      text: "Rien de rédhibitoire, mais chaque défaut repéré est un montant à soustraire du prix.",
    };
  } else if (essentialsLeft > 0) {
    verdict = {
      tone: "info",
      title: "Visite en cours",
      text:
        essentialsLeft > 1
          ? `${essentialsLeft} points essentiels restent à vérifier.`
          : "Un point essentiel reste à vérifier.",
    };
  } else if (warns > 0) {
    verdict = {
      tone: "warn",
      title: warns > 1 ? `${warns} points à négocier` : "Un point à négocier",
      text: "Le bien tient ses promesses, à un ou deux détails près : utilisez-les dans votre offre.",
    };
  } else {
    verdict = {
      tone: "ok",
      title: "Bien conforme à l'annonce",
      text: positives > 0 ? "Aucune alerte, et des arguments pour négocier malgré tout." : "Aucune alerte relevée sur les points vérifiés.",
    };
  }

  const total = items.length;
  const level = leverLevel(leverScore);

  return {
    phase,
    verdict,
    counts: {
      total,
      answered,
      remaining: Math.max(0, total - answered),
      essentials,
      essentialsAnswered,
      discover,
      confirm,
      corrections: corrections.length,
      alerts: alerts.length,
      dangers,
      warns,
      todo: todo.length,
      progress: total > 0 ? Math.round((answered / total) * 100) : 0,
    },
    alerts,
    corrections,
    todo,
    lever: { score: leverScore, level, label: LEVER_LABELS[level], reasons: leverReasons },
    costs: {
      charges,
      taxe,
      energy,
      annual: annualTotal,
      monthly: annualTotal > 0 ? Math.round(annualTotal / 12) : 0,
      known: annualParts.length,
    },
    works: { min: worksMin, max: worksMax, items: works },
    effective,
    price: toNumber(listing.price),
    pricePerSqm:
      toNumber(listing.price) && toNumber(effective.surface)
        ? Math.round(toNumber(listing.price) / toNumber(effective.surface))
        : null,
  };
}

export default computeInsights;
