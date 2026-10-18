/**
 * Catalogue de la fiche de préparation de visite.
 *
 * Les questions sont organisées selon le DÉROULÉ RÉEL d'une visite (étapes),
 * pas par thème abstrait : ce qu'on demande avant de partir, ce qu'on observe
 * en arrivant, ce qu'on vérifie à l'intérieur, les chiffres à obtenir, puis
 * le ressenti à chaud. Chaque question porte en plus un THÈME (copropriété,
 * taxes, travaux…) qui sert de filtre et de pastille.
 *
 * Certaines questions sont liées à un champ canonique de l'annonce (`field`) :
 * la réponse devient une correction de ce champ, provenance « visite » (voir
 * listing-field-provenance.js).
 *
 * `signals` : règles déclaratives évaluées dans le navigateur ET côté serveur
 * (lib/visit/visit-insights.js). Une règle produit une note sous la question
 * et alimente le bilan (alertes, levier de négociation, budget travaux).
 *   when  : "yes" | "no" | "unknown" | "answered" | "value:a,b" | "gte:N" |
 *           "lte:N" | "corrected" | "below_pct:N" (valeur corrigée < connue de N %)
 *   tone  : "ok" | "info" | "warn" | "danger"
 *   cost  : [min, max] € de travaux probables (budget travaux du bilan)
 *   lever : points de levier de négociation (0..3)
 *
 * Types d'input (public/js/visit-sheet.js) :
 *   confirm_number · confirm_yesno · number · confirm_letter · yesno · yesno_number · choice · scale · text
 *   confirm_yesno : oui/non (valeur annonce affichée si connue) ; si non, saisie de correction.
 *   yesno · confirm_number : unknownOption + unknownLabel pour un segment « À confirmer » / « Je ne sais pas » (réponse unknown).
 *   count_pair : deux compteurs (value { clé: number }) — ex. salles de bain à refaire / rafraîchir.
 *   yesno_number : oui/non puis montant si oui (detailLabel, unit…).
 *   choice : options { value, label, other?: true } ; « Autre » ouvre un champ texte.
 *
 * `audience` : "copro" (appartement ou bien en copropriété) | "house" | "apartment" | null.
 * `showWhen` : { questionId, values[] } affiche la question seulement si le parent (choice) a l'une de ces valeurs.
 * `photo` : lien avec les faits structurés de l'analyse photo (lib/visit/visit-photo-facts.js).
 *   { facts: ["anomaly:possible_mold", …], required?: true, hint?: "…" }
 *   - required : la question n'existe que si un des faits est présent (questions `photo_*`).
 *   - hint     : indice affiché sous la question quand un fait correspond.
 *   Slots dans `question` et `hint` : {rooms} (pièces concernées), {claims} (affirmations de l'annonce).
 *   Jamais de texte libre du modèle : seuls les vocabulaires fermés déclenchent quelque chose.
 */

export const VISIT_SECTIONS = [
  {
    id: "avant",
    label: "Avant la visite",
    lead: "À demander à l'agent ou au vendeur, par téléphone ou en arrivant : cinq minutes qui cadrent toute la négociation.",
    icon: "message",
  },
  {
    id: "exterieur",
    label: "Autour et dehors",
    lead: "Avant même d'entrer : le quartier, l'immeuble ou la façade, ce qui ne se change pas.",
    icon: "sun",
  },
  {
    id: "interieur",
    label: "À l'intérieur",
    lead: "Pièce par pièce, ouvrez, touchez, écoutez : la surface, la lumière et l'état réel.",
    icon: "door",
  },
  {
    id: "chiffres",
    label: "Les chiffres à obtenir",
    lead: "Les montants réels, justificatifs à l'appui : c'est ce qui fait votre vrai budget.",
    icon: "receipt",
  },
  {
    id: "ressenti",
    label: "Mon ressenti",
    lead: "À chaud, en sortant. C'est souvent le meilleur indicateur, à condition de l'écrire.",
    icon: "star",
  },
];

export const VISIT_SECTION_BY_ID = Object.fromEntries(VISIT_SECTIONS.map((s) => [s.id, s]));

/** Thèmes transverses (pastille + filtre). `icon` = symbole du sprite works-icons. */
export const VISIT_THEMES = [
  { id: "negociation", label: "Négociation", icon: "coins" },
  { id: "juridique", label: "Juridique", icon: "shield" },
  { id: "copropriete", label: "Copropriété", icon: "building" },
  { id: "fiscalite", label: "Taxes & charges", icon: "receipt" },
  { id: "travaux", label: "Travaux & état", icon: "hammer" },
  { id: "energie", label: "Énergie", icon: "zap" },
  { id: "surface", label: "Espace & confort", icon: "home" },
  { id: "environnement", label: "Quartier", icon: "sun" },
  { id: "ressenti", label: "Ressenti", icon: "star" },
];

export const VISIT_THEME_BY_ID = Object.fromEntries(VISIT_THEMES.map((t) => [t.id, t]));

const YESNO = { type: "yesno" };

/** Oui / Non / Je ne sais pas (réponse `unknown`, même sémantique que « Je demanderai sur place »). */
const YESNO_UNKNOWN = { type: "yesno", unknownOption: true, unknownLabel: "Je ne sais pas" };

/** Oui / Non / À confirmer (réponse `unknown`) — point juridique à lever avant ou pendant la visite. */
const YESNO_A_CONFIRMER = { type: "yesno", unknownOption: true, unknownLabel: "À confirmer" };

/** Contrôle physique sur place (questions déclenchées par l'analyse photo). */
export const INPUT_SITE_CHECK = {
  type: "choice",
  layout: "list",
  options: [
    { value: "ok", label: "Rien à signaler" },
    { value: "issue", label: "Problème constaté" },
  ],
};

/** Faits « humidité » de l'analyse photo, partagés par plusieurs questions. */
const HUMIDITY_FACTS = ["anomaly:possible_humidity", "anomaly:possible_water_damage", "anomaly:possible_mold"];

/** Catalogue curé. L'ordre dans une étape est conservé. */
export const VISIT_QUESTIONS = [
  /* ============================ 1. Avant la visite ============================ */
  {
    id: "sale_reason",
    section: "avant",
    theme: "negociation",
    essential: true,
    question: "Pourquoi les vendeurs vendent-ils ?",
    proTip:
      "Mutation, succession, divorce, achat déjà signé ailleurs : un vendeur pressé est votre meilleur levier. Posez la question l'air de rien.",
    input: {
      type: "choice",
      options: [
        { value: "life_change", label: "Changement de situation personnelle" },
        { value: "mutation", label: "Mutation / déménagement" },
        { value: "succession", label: "Succession ou donation" },
        { value: "separation", label: "Divorce" },
        { value: "investment_exit", label: "Sortie d'un investissement locatif" },
        { value: "other", label: "Autre", other: true },
      ],
    },
    signals: [
      { when: "answered", tone: "ok", text: "Notez-le : la raison de la vente guide le rythme et la marge de négociation." },
      { when: "value:mutation", tone: "ok", text: "Vendeur souvent pressé : marge de négociation possible si votre dossier est solide.", lever: 2 },
      { when: "value:investment_exit", tone: "ok", text: "Sortie locative : le vendeur peut accepter une offre rapide plutôt que le prix affiché.", lever: 1 },
      { when: "value:succession,separation", tone: "info", text: "Vente familiale : parfois moins de marge, parfois urgence de partage entre héritiers." },
    ],
  },
  {
    id: "time_on_market",
    section: "avant",
    theme: "negociation",
    question: "Depuis combien de temps le bien est-il en vente ?",
    proTip:
      "Au-delà de 3 mois, le prix a probablement été jugé trop élevé par le marché. Comparez avec la date de première publication de l'annonce.",
    input: { type: "number", unit: "mois", decimals: 0, min: 0, max: 120 },
    signals: [
      { when: "gte:3", tone: "ok", text: "Plus de 3 mois en vente : argument solide pour négocier.", lever: 2 },
      { when: "gte:6", tone: "ok", text: "Plus de 6 mois : le vendeur a sans doute déjà refusé des offres basses, mais s'est lassé.", lever: 1 },
    ],
  },
  {
    id: "other_offers",
    section: "avant",
    theme: "negociation",
    essential: true,
    question: "Y a-t-il déjà eu des offres ?",
    proTip:
      "Faites préciser : « d'autres acheteurs intéressés » sert parfois juste à presser. Un bien très visité mais invendu cache souvent un défaut ou un prix trop haut.",
    input: YESNO,
    signals: [
      { when: "no", tone: "ok", text: "Aucune offre : vous êtes en position de force pour proposer sous le prix.", lever: 2 },
      { when: "yes", tone: "info", text: "Des offres en cours ou acceptées ailleurs : faites préciser le statut et le montant." },
    ],
  },
  {
    id: "offer_refused",
    section: "avant",
    theme: "negociation",
    question: "Une offre a-t-elle déjà été proposée et refusée ?",
    proTip:
      "Demandez le montant refusé : c'est souvent le seul repère fiable du plancher du vendeur, plus parlant que le prix affiché.",
    input: YESNO,
    signals: [
      {
        when: "yes",
        tone: "ok",
        text: "Offre refusée : le prix proposé indique ce que le vendeur a repoussé. Recadrez votre offre en dessous de ce seuil.",
        lever: 2,
      },
    ],
  },
  {
    id: "negotiation_room",
    section: "avant",
    theme: "negociation",
    essential: true,
    question: "Le prix est-il négociable ? Jusqu'où ?",
    proTip:
      "Demandez « le vendeur a-t-il une marge ? » puis taisez-vous. L'agent lâche souvent un chiffre. Appuyez-vous sur les travaux et le prix au m² du quartier.",
    input: {
      type: "yesno_number",
      unit: "€",
      decimals: 0,
      min: 0,
      max: 500000,
      detailLabel: "Marge annoncée",
      placeholder: "Montant sous le prix affiché",
      validate: {
        maxExclusive: "listingPrice",
        maxExclusiveMessage:
          "La marge annoncée doit être inférieure au prix affiché du bien (montant égal ou supérieur au prix).",
      },
    },
    signals: [
      { when: "no", tone: "info", text: "Prix présenté comme ferme : appuyez-vous sur les travaux et le marché pour proposer en dessous." },
      { when: "gte:1", tone: "ok", text: "Gardez ce montant pour votre offre : c'est la marge que le vendeur laisse entendre.", lever: 1 },
    ],
  },
  {
    id: "photo_claims",
    section: "avant",
    theme: "negociation",
    question: "L'annonce affirme {claims} : les photos semblent le contredire. Qu'en est-il sur place ?",
    proTip:
      "Demandez à l'agent de préciser ce qui a été réellement fait (dates, factures, nature des travaux). Un écart entre le texte et la réalité est un argument de négociation légitime et documenté.",
    photo: {
      facts: ["claim:contradicted"],
      required: true,
      hint: "Sur les photos : l'affirmation {claims} ne semble pas vérifiée.",
    },
    input: {
      type: "choice",
      layout: "list",
      options: [
        { value: "confirmed", label: "Écart confirmé sur place" },
        { value: "listing_right", label: "L'annonce avait raison" },
      ],
    },
    signals: [
      {
        when: "value:confirmed",
        tone: "warn",
        text: "Annonce inexacte : notez-le par écrit, c'est un levier solide pour votre offre.",
        lever: 2,
      },
    ],
  },
  {
    id: "diagnostics",
    section: "avant",
    theme: "juridique",
    question: "Le dossier de diagnostics (DDT) est-il complet et consultable ?",
    proTip:
      "DPE, amiante, plomb, termites, électricité, gaz, ERP… Demandez-le avant de faire une offre : il révèle les travaux de sécurité à prévoir.",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Sans DDT, ne vous engagez pas : exigez-le avant toute offre écrite." }],
  },
  {
    id: "copro_docs",
    section: "avant",
    theme: "copropriete",
    audience: "copro",
    question: "Les 3 derniers PV d'AG et le règlement de copropriété sont-ils disponibles ?",
    proTip:
      "Les PV racontent la vraie vie de l'immeuble : travaux votés, conflits, impayés. Le règlement dit ce que vous avez le droit de faire (location courte durée, travaux…).",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Réclamez-les : ils sont obligatoires au compromis, autant les lire avant d'offrir." }],
  },
  {
    id: "servitudes",
    section: "avant",
    theme: "juridique",
    audience: "house",
    question: "Existe-t-il des servitudes, mitoyennetés ou litiges en cours ?",
    proTip:
      "Droit de passage, mur mitoyen, litige de bornage ou de voisinage : demandez le titre de propriété. Ces points limitent vos droits sur le bien.",
    input: YESNO_A_CONFIRMER,
    signals: [{ when: "yes", tone: "warn", text: "Une servitude ou un litige se négocie : faites-le préciser par écrit avant l'offre.", lever: 1 }],
  },
  {
    id: "litiges",
    section: "avant",
    theme: "juridique",
    audience: "apartment",
    question: "Existe-t-il des litiges en cours ?",
    proTip:
      "Conflit de copropriété, procédure engagée contre un voisin ou le syndic : demandez s'il figure aux PV d'AG ou au compromis.",
    input: YESNO_A_CONFIRMER,
    signals: [{ when: "yes", tone: "warn", text: "Un litige en cours se négocie : faites-le préciser par écrit avant l'offre.", lever: 1 }],
  },
  {
    id: "year_built",
    section: "avant",
    theme: "travaux",
    field: "year_built",
    question: "Quelle est l'année de construction ?",
    proTip:
      "Avant 1949 : plomb possible. Avant 1997 : amiante possible. Avant 1975 : pas d'isolation d'origine. Après 2012 : normes RT2012, bien isolé.",
    input: {
      type: "confirm_number",
      decimals: 0,
      min: 1600,
      max: 2100,
      groupThousands: false,
      validate: {
        min: 1900,
        max: "currentYear",
        minMessage: "Année antérieure à 1900 : vérifiez la saisie.",
        maxMessage: "Année postérieure à l'année en cours : le bien n'est pas encore construit.",
      },
    },
    signals: [
      { when: "lte:1948", tone: "info", text: "Construction ancienne : diagnostic plomb et amiante indispensables, charme mais travaux." },
      { when: "lte:1974", tone: "info", text: "Pas d'isolation d'origine à cette époque : vérifiez ce qui a été refait." },
    ],
  },

  /* ============================ 2. Autour et dehors ============================ */
  {
    id: "quiet",
    section: "exterieur",
    theme: "environnement",
    essential: true,
    question: "Le quartier et la rue sont-ils calmes ?",
    proTip:
      "Revenez à différents moments (soir, week-end). Repérez bars, écoles, voie passante, héliport. Le bruit est le seul défaut qu'on ne répare pas.",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Nuisance sonore : difficile à revendre, décote à négocier dès maintenant.", lever: 1 }],
  },
  {
    id: "amenities",
    section: "exterieur",
    theme: "environnement",
    question: "Commerces, écoles et transports à proximité ?",
    proTip: "La proximité des commodités soutient la valeur à la revente. Testez le trajet domicile-travail aux heures de pointe.",
    input: { type: "text", placeholder: "Métro à 5 min, école, boulangerie…" },
  },
  {
    id: "transport_time",
    section: "exterieur",
    theme: "environnement",
    question: "Temps réel à pied jusqu'au transport le plus proche ?",
    proTip: "Chronométrez-le vous-même : les « 5 minutes » des annonces en font souvent 12.",
    input: { type: "number", unit: "min", decimals: 0, min: 0, max: 120 },
    signals: [{ when: "gte:15", tone: "info", text: "Plus de 15 minutes : prévoyez vélo ou voiture, et vérifiez le stationnement." }],
  },
  {
    id: "parking_street",
    section: "exterieur",
    theme: "environnement",
    question: "Se gare-t-on facilement dans la rue ?",
    proTip: "Passez un soir vers 20 h : c'est là qu'on voit la vérité du stationnement.",
    input: YESNO,
  },
  {
    id: "risks",
    section: "exterieur",
    theme: "environnement",
    question: "Le bien est-il exposé à des risques ou nuisances ?",
    proTip:
      "Vérifiez Géorisques.gouv.fr (inondation, argile, radon) et le PLU en mairie pour les projets voisins (immeuble, route, antenne).",
    input: YESNO,
    signals: [{ when: "yes", tone: "warn", text: "Risque identifié : impact sur l'assurance et la revente, à chiffrer avant l'offre.", lever: 1 }],
  },
  {
    id: "exposure",
    section: "exterieur",
    theme: "surface",
    question: "Le bâtiment est-il dégagé, sans vis-à-vis direct ?",
    proTip: "Un vis-à-vis à moins de 10 m assombrit et pèse à la revente. Regardez aussi ce qui pourrait se construire sur le terrain d'en face.",
    input: YESNO,
  },
  {
    id: "facade",
    section: "exterieur",
    theme: "travaux",
    audience: "copro",
    question: "Façade, toiture et parties communes semblent-elles entretenues ?",
    proTip:
      "Façade fissurée, hall défraîchi, boîtes aux lettres forcées : signes d'une copro qui ne vote pas les travaux… ou qui va les voter bientôt à vos frais.",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Immeuble négligé : un ravalement ou une toiture votés peuvent coûter 5 000 à 15 000 € par lot.", cost: [5000, 15000], lever: 1 }],
  },
  {
    id: "roof",
    section: "exterieur",
    theme: "travaux",
    audience: "house",
    essential: true,
    question: "La toiture, la charpente et les gouttières sont-elles en bon état ?",
    proTip:
      "Tuiles déplacées, mousse épaisse, gouttières percées, traces d'infiltration dans les combles. Une réfection coûte 10 000 à 25 000 €.",
    input: YESNO,
    signals: [{ when: "no", tone: "danger", text: "Toiture à reprendre : faites établir un devis avant l'offre, c'est le poste le plus lourd.", cost: [10000, 25000], lever: 2 }],
  },
  {
    id: "land_surface",
    section: "exterieur",
    theme: "surface",
    audience: "house",
    field: "land_surface",
    question: "La surface du terrain correspond-elle à l'annonce ?",
    proTip: "Demandez le plan cadastral ou le bornage : une clôture n'est pas une limite de propriété.",
    input: { type: "confirm_number", unit: "m²", decimals: 0, min: 1, max: 1000000 },
  },
  {
    id: "neighbors",
    section: "exterieur",
    theme: "environnement",
    question: "Avez-vous pu croiser des voisins ? Quelle impression ?",
    proTip: "Trois questions à un voisin valent dix à l'agent : bruit, travaux, ambiance, problèmes récurrents.",
    input: { type: "text", placeholder: "Accueillants, discrets, étudiants, familles…" },
  },

  /* ============================ 3. À l'intérieur ============================ */
  {
    id: "surface",
    section: "interieur",
    theme: "surface",
    field: "surface",
    essential: true,
    question: "La surface habitable annoncée est-elle confirmée lors de la visite ?",
    proTip:
      "Exigez la surface loi Carrez du titre de propriété. En copropriété, un écart de plus de 5 % permet de renégocier le prix, même après l'achat.",
    input: { type: "confirm_number", unit: "m²", decimals: 1, min: 1, max: 10000 },
    signals: [
      { when: "below_pct:5", tone: "danger", text: "Plus de 5 % d'écart avec l'annonce : le prix au m² réel est plus élevé, négociez proportionnellement.", lever: 2 },
      { when: "corrected", tone: "info", text: "Surface corrigée : toutes les estimations (travaux, prix au m²) sont recalculées avec votre mesure." },
    ],
  },
  {
    id: "rooms",
    section: "interieur",
    theme: "surface",
    field: "rooms",
    question: "Le nombre de pièces est-il correct ?",
    proTip:
      "On compte les pièces de vie (séjour + chambres), hors cuisine, salle de bains et WC. Une pièce sans fenêtre ne compte pas comme chambre.",
    input: { type: "confirm_yesno", unit: "pièces", decimals: 0, min: 1, max: 50, groupThousands: false },
  },
  {
    id: "bedrooms",
    section: "interieur",
    theme: "surface",
    field: "bedrooms",
    question: "Le nombre de chambres est-il correct ?",
    proTip: "Une chambre doit avoir une fenêtre et au moins 9 m² pour être louée. Les « bureaux » de 6 m² n'en sont pas.",
    input: { type: "confirm_yesno", unit: "chambres", decimals: 0, min: 0, max: 30, groupThousands: false },
  },
  {
    id: "floor",
    section: "interieur",
    theme: "surface",
    field: "floor",
    audience: "copro",
    question: "L'étage est-il correct, et y a-t-il un ascenseur ?",
    proTip: "Sans ascenseur, au-delà du 3e étage la revente est plus lente. Avec ascenseur, vérifiez sa date de révision dans les PV d'AG.",
    input: { type: "confirm_number", decimals: 0, min: -2, max: 60 },
  },
  {
    id: "elevator",
    section: "interieur",
    theme: "copropriete",
    audience: "copro",
    question: "L'ascenseur fonctionne-t-il et est-il récent ?",
    proTip:
      "Dans la cabine, repérez l'étiquette ou le carnet d'entretien (dernière visite, prochain contrôle) et tout affichage de maintenance : une date récente rassure sur le bon fonctionnement. Le remplacement coûte 50 000 à 150 000 € à la copro : au-delà de 30 ans, c'est souvent pour bientôt.",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Ascenseur ancien ou en panne : des travaux de copropriété sont probables.", cost: [2000, 8000] }],
  },
  {
    id: "elevator_install_date",
    section: "interieur",
    theme: "copropriete",
    audience: "copro",
    question: "Arrivez-vous à obtenir l'ancienneté de l'ascenseur ?",
    proTip:
      "Demandez au gardien, au syndic ou dans les PV d'AG (modernisation, contrat de maintenance). La plaque constructeur ou l'étiquette d'entretien dans la cabine indique parfois l'année de mise en service.",
    input: {
      type: "yesno_number",
      decimals: 0,
      min: 0,
      max: 80,
      groupThousands: false,
      unit: "ans",
      detailLabel: "Ancienneté",
      placeholder: "Ex. 15",
    },
    signals: [
      {
        when: "no",
        tone: "info",
        text: "Sans ancienneté connue, l'âge réel reste incertain : exigez un chiffre par écrit avant l'offre ou provisionnez un gros poste copropriété.",
        lever: 1,
      },
      {
        when: "gte:30",
        tone: "warn",
        text: "Plus de 30 ans : un remplacement ou une modernisation lourde en copropriété devient probable.",
        lever: 1,
      },
    ],
  },
  {
    id: "brightness",
    section: "interieur",
    theme: "surface",
    essential: true,
    question: "Le logement est-il lumineux, lumières éteintes ?",
    proTip: "Demandez à éteindre toutes les lampes : les agents les allument toutes pour une bonne raison. Visitez idéalement en journée.",
    input: YESNO,
    signals: [{ when: "no", tone: "info", text: "Logement sombre : c'est un argument de prix, et un critère de revente." , lever: 1 }],
  },
  {
    id: "orientation",
    section: "interieur",
    theme: "surface",
    question: "Quelle est l'orientation du séjour ?",
    proTip:
      "Sud = lumineux et plus chaud l'hiver ; Ouest = soleil du soir ; Nord = sombre et plus frais ; Est = soleil du matin. Repérez la course du soleil ou ouvrez une appli boussole sur votre smartphone, dos au mur des fenêtres du séjour.",
    input: {
      type: "choice",
      options: [
        { value: "sud", label: "Sud" },
        { value: "est", label: "Est" },
        { value: "ouest", label: "Ouest" },
        { value: "nord", label: "Nord" },
        { value: "traversant", label: "Traversant" },
      ],
    },
    signals: [
      { when: "value:sud", tone: "ok", text: "Plein sud : bon ensoleillement l'hiver, pièces lumineuses, souvent très recherché." },
      { when: "value:est", tone: "info", text: "Est : soleil du matin, pièces fraîches le soir, agréable pour chambres et cuisine." },
      { when: "value:ouest", tone: "info", text: "Ouest : soleil de fin de journée, séjour chaud l'été. Prévoir occultation si baies larges." },
      { when: "value:nord", tone: "info", text: "Plein nord : factures de chauffage plus élevées et pièces sombres l'hiver." },
      {
        when: "value:traversant",
        tone: "ok",
        text: "Traversant : lumière matin et soir, bonne ventilation naturelle, atout confort et revente.",
      },
    ],
  },
  {
    id: "ceiling_height",
    section: "interieur",
    theme: "surface",
    question: "La hauteur sous plafond est-elle supérieure à la normale (> 2,50 m) ?",
    proTip:
      "Au-delà de 2,50 m, les volumes plaisent davantage et c'est un vrai élément de surcote à la revente. Mesurez au mètre si besoin. Sous 1,80 m la surface n'est pas comptée en loi Carrez : vérifiez les combles « aménageables » annoncés.",
    input: YESNO,
  },
  {
    id: "layout",
    section: "interieur",
    theme: "surface",
    question: "La distribution des pièces vous convient-elle ?",
    proTip: "Pièces en enfilade, chambre traversée pour aller aux WC, cuisine fermée : abattre une cloison coûte 1 500 à 4 000 € s'il n'est pas porteur.",
    input: YESNO,
    signals: [{ when: "no", tone: "info", text: "Distribution à revoir : vérifiez quels murs sont porteurs avant de compter sur des travaux.", cost: [1500, 4000] }],
  },
  {
    id: "storage",
    section: "interieur",
    theme: "surface",
    question: "Y a-t-il assez de rangements (placards, cellier) ?",
    proTip: "Sans placards intégrés, comptez 1 000 à 3 000 € d'aménagements et quelques m² perdus en armoires.",
    input: YESNO,
  },
  {
    id: "annexes",
    section: "interieur",
    theme: "surface",
    question: "Cave, parking, box ou grenier sont-ils inclus ?",
    proTip: "Une place de parking en ville vaut 10 000 à 30 000 €. Vérifiez qu'elle est bien attachée au lot vendu, pas seulement « louée ».",
    input: YESNO,
    signals: [{ when: "yes", tone: "ok", text: "Annexes incluses : vérifiez qu'elles figurent dans la désignation du lot au compromis." }],
  },
  {
    id: "noise_inside",
    section: "interieur",
    theme: "environnement",
    question: "Fenêtres fermées, entend-on la rue ou les voisins ?",
    proTip: "Restez une minute en silence dans chaque pièce. Les bruits de voisinage se jouent souvent sur les murs mitoyens et les planchers.",
    input: YESNO,
    signals: [{ when: "yes", tone: "warn", text: "Isolation phonique faible : coûteuse à corriger, à négocier.", lever: 1 }],
  },
  {
    id: "floors_walls",
    section: "interieur",
    theme: "travaux",
    question: "Sols, murs et plafonds sont-ils en bon état ?",
    proTip: "Regardez les angles, derrière les meubles et sous les tapis. Un rafraîchissement complet coûte 30 à 60 €/m².",
    input: YESNO,
    signals: [{ when: "no", tone: "info", text: "Rafraîchissement à prévoir : peintures et sols, à chiffrer par pièce.", cost: [3000, 9000] }],
  },
  {
    id: "humidity",
    section: "interieur",
    theme: "travaux",
    essential: true,
    question: "Avez-vous repéré de l'humidité, des fissures ou un dégât des eaux ?",
    proTip:
      "Plafonds, bas des murs, sous les fenêtres, derrière les meubles. Odeur de renfermé, cloques de peinture, joints noircis : ne croyez pas « c'est ancien ».",
    photo: {
      facts: [...HUMIDITY_FACTS, "anomaly:crack"],
      hint: "Sur les photos : traces d'humidité ou fissures possibles ({rooms}).",
    },
    input: YESNO,
    signals: [{ when: "yes", tone: "danger", text: "Humidité ou fissures : exigez l'origine et un devis avant toute offre. Ne signez pas sans.", cost: [2000, 12000], lever: 2 }],
  },
  {
    id: "photo_humidity",
    section: "interieur",
    theme: "travaux",
    essential: true,
    question: "Les traces d'humidité repérées sur les photos ({rooms}) sont-elles réelles ?",
    proTip:
      "Touchez le mur : froid et humide signale une infiltration ou un pont thermique. Cherchez l'odeur de cave, les cloques, les joints noircis, les auréoles au plafond. Demandez s'il y a eu un dégât des eaux et si la cause a été traitée.",
    photo: {
      facts: HUMIDITY_FACTS,
      required: true,
      hint: "Sur les photos : humidité, dégât des eaux ou moisissure possibles ({rooms}).",
    },
    input: INPUT_SITE_CHECK,
    signals: [
      {
        when: "value:issue",
        tone: "danger",
        text: "Humidité confirmée : exigez l'origine, le traitement effectué et un devis avant toute offre.",
        cost: [2000, 8000],
        lever: 2,
      },
      { when: "value:ok", tone: "ok", text: "Rien de visible sur place : gardez un œil sur l'odeur et les plinthes lors d'une seconde visite." },
    ],
  },
  {
    id: "photo_cracks",
    section: "interieur",
    theme: "travaux",
    essential: true,
    question: "Les fissures visibles sur les photos ({rooms}) sont-elles superficielles ?",
    proTip:
      "Une fissure fine et droite dans l'enduit est souvent bénigne. Une fissure en escalier, traversante ou de plus de 2 mm, surtout en angle de mur ou autour d'une ouverture, peut être structurelle : faites passer un expert avant d'offrir.",
    photo: {
      facts: ["anomaly:crack"],
      required: true,
      hint: "Sur les photos : fissures repérées ({rooms}).",
    },
    input: INPUT_SITE_CHECK,
    signals: [
      {
        when: "value:issue",
        tone: "danger",
        text: "Fissure préoccupante : demandez un avis d'expert structure et conditionnez votre offre à son rapport.",
        cost: [1500, 10000],
        lever: 2,
      },
    ],
  },
  {
    id: "photo_surfaces",
    section: "interieur",
    theme: "travaux",
    question: "Les plafonds, peintures ou sols dégradés vus sur les photos ({rooms}) sont-ils à reprendre ?",
    proTip:
      "Regardez si la dégradation est locale (un coin, une pièce) ou générale. Un plafond taché peut cacher une fuite au-dessus : demandez si elle est réparée.",
    photo: {
      facts: ["anomaly:ceiling_damage", "anomaly:peeling_paint", "anomaly:damaged_floor"],
      required: true,
      hint: "Sur les photos : plafond, peinture ou sol abîmés ({rooms}).",
    },
    input: INPUT_SITE_CHECK,
    signals: [
      {
        when: "value:issue",
        tone: "warn",
        text: "Surfaces à reprendre : chiffrez peinture et sol par pièce, 30 à 60 €/m².",
        cost: [2000, 8000],
        lever: 1,
      },
    ],
  },
  {
    id: "photo_joinery",
    section: "interieur",
    theme: "travaux",
    question: "Les menuiseries abîmées vues sur les photos ({rooms}) ferment-elles encore correctement ?",
    proTip:
      "Ouvrez et fermez chaque fenêtre et porte-fenêtre : jeu, bois pourri, joints morts, condensation entre les vitres. Une menuiserie à changer coûte 400 à 800 € posée.",
    photo: {
      facts: ["anomaly:damaged_joinery"],
      required: true,
      hint: "Sur les photos : menuiseries dégradées ({rooms}).",
    },
    input: INPUT_SITE_CHECK,
    signals: [
      {
        when: "value:issue",
        tone: "warn",
        text: "Menuiseries à remplacer : 400 à 800 € par ouverture.",
        cost: [1200, 4800],
        lever: 1,
      },
    ],
  },
  {
    id: "photo_wiring",
    section: "interieur",
    theme: "travaux",
    question: "Les câbles apparents vus sur les photos ({rooms}) révèlent-ils une installation hors normes ?",
    proTip:
      "Suivez les fils jusqu'au tableau : fusibles à porcelaine, absence de différentiel 30 mA, prises sans terre, dominos apparents. Le diagnostic électrique du DDT liste les anomalies.",
    photo: {
      facts: ["anomaly:visible_wiring"],
      required: true,
      hint: "Sur les photos : câblage apparent ({rooms}).",
    },
    input: INPUT_SITE_CHECK,
    signals: [
      {
        when: "value:issue",
        tone: "warn",
        text: "Électricité à sécuriser : mise en sécurité 3 000 à 8 000 €, à déduire de l'offre.",
        cost: [3000, 8000],
        lever: 1,
      },
    ],
  },
  {
    id: "windows",
    section: "interieur",
    theme: "travaux",
    essential: true,
    question: "Les fenêtres sont-elles en double vitrage récent ?",
    proTip: "Le simple vitrage laisse passer froid et bruit. Comptez 400 à 800 € par fenêtre pour les changer.",
    photo: {
      facts: ["glazing:single_likely"],
      hint: "Sur les photos : simple vitrage probable ({rooms}).",
    },
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Simple vitrage ou menuiseries anciennes : 400 à 800 € par fenêtre.", cost: [2400, 6400], lever: 1 }],
  },
  {
    id: "electricity",
    section: "interieur",
    theme: "travaux",
    essential: true,
    question: "L'installation électrique est-elle récente et aux normes ?",
    proTip:
      "Tableau à fusibles en porcelaine, prises sans terre, fils apparents : plus de 15 ans = remise aux normes 3 000 à 8 000 €. Exigez le diagnostic électrique.",
    photo: {
      facts: ["anomaly:visible_wiring"],
      hint: "Sur les photos : câblage apparent ({rooms}).",
    },
    input: YESNO_UNKNOWN,
    signals: [{ when: "no", tone: "warn", text: "Électricité à reprendre : mise en sécurité 3 000 à 8 000 €.", cost: [3000, 8000], lever: 1 }],
  },
  {
    id: "plumbing",
    section: "interieur",
    theme: "travaux",
    question: "La plomberie et l'évacuation sont-elles en bon état ?",
    proTip: "Ouvrez les robinets, tirez la chasse, vérifiez la pression et l'écoulement. Des tuyaux en plomb sont à remplacer impérativement.",
    input: YESNO_UNKNOWN,
    signals: [{ when: "no", tone: "warn", text: "Plomberie à revoir : 2 000 à 6 000 € selon l'ampleur.", cost: [2000, 6000] }],
  },
  {
    id: "heating",
    section: "interieur",
    theme: "travaux",
    essential: true,
    question: "Le chauffage fonctionne-t-il bien et a-t-il moins de 15 ans ?",
    proTip: "Une chaudière de plus de 15 ans est à remplacer (3 000 à 6 000 €). Demandez la dernière facture d'entretien.",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Chaudière ou chauffage en fin de vie : 3 000 à 6 000 €.", cost: [3000, 6000], lever: 1 }],
  },
  {
    id: "heating_type",
    section: "interieur",
    theme: "energie",
    field: "heating_system",
    question: "Quel est le type de chauffage ?",
    proTip: "Le fioul sera interdit au remplacement et coûte cher. Le collectif se répercute dans les charges. La pompe à chaleur est le plus économe.",
    input: {
      type: "choice",
      options: [
        { value: "gaz_individuel", label: "Gaz individuel" },
        { value: "collectif", label: "Collectif" },
        { value: "electrique", label: "Électrique" },
        { value: "pac", label: "Pompe à chaleur" },
        { value: "fioul", label: "Fioul" },
        { value: "bois", label: "Bois / granulés" },
      ],
    },
    signals: [
      { when: "value:fioul", tone: "warn", text: "Fioul : remplacement obligatoire à terme, comptez 8 000 à 15 000 € pour une pompe à chaleur.", cost: [8000, 15000], lever: 1 },
      { when: "value:electrique", tone: "info", text: "Électrique : factures élevées si l'isolation est faible, vérifiez le DPE." },
    ],
  },
  {
    id: "hot_water_production",
    section: "interieur",
    theme: "travaux",
    essential: true,
    question: "Comment l'eau chaude est-elle produite ?",
    proTip:
      "Ballon dans un placard ou local technique, chaudière murale, PAC ou production collective en chaufferie : demandez si besoin au gardien ou au syndic. En copropriété, l'ECS collective évite un ballon dans l'appartement.",
    input: {
      type: "choice",
      options: [
        { value: "ballon_electrique", label: "Ballon électrique" },
        { value: "thermodynamique", label: "Chauffe-eau thermodynamique" },
        { value: "chaudiere", label: "Chaudière individuelle" },
        { value: "collectif", label: "Collectif (copropriété)" },
        { value: "pac", label: "Pompe à chaleur" },
        { value: "autre", label: "Autre", other: true },
      ],
    },
    signals: [
      {
        when: "value:collectif",
        tone: "info",
        text: "ECS collective : pas de ballon à entretenir dans le logement. Vérifiez ce qui est compris dans les charges.",
      },
    ],
  },
  {
    id: "water_heater",
    section: "interieur",
    theme: "travaux",
    showWhen: {
      questionId: "hot_water_production",
      values: ["ballon_electrique", "thermodynamique"],
    },
    question: "Le ballon a-t-il moins de 10 ans ?",
    proTip: "L'étiquette sur le ballon indique l'année. Au-delà de 10 ans, prévoyez 800 à 1 500 €.",
    input: YESNO_UNKNOWN,
    signals: [{ when: "no", tone: "info", text: "Ballon en fin de vie : 800 à 1 500 €.", cost: [800, 1500] }],
  },
  {
    id: "ecs_equipment_age",
    section: "interieur",
    theme: "travaux",
    showWhen: {
      questionId: "hot_water_production",
      values: ["chaudiere", "pac"],
    },
    question: "L'équipement (chaudière ou PAC) a-t-il moins de 15 ans et un entretien récent ?",
    proTip:
      "Demandez la dernière facture d'entretien annuel (obligatoire pour le gaz). Au-delà de 15 ans, prévoyez un remplacement ou une grosse révision.",
    input: YESNO_UNKNOWN,
    signals: [
      {
        when: "no",
        tone: "warn",
        text: "Production ECS / chauffage en fin de vie ou mal entretenue : 3 000 à 8 000 €.",
        cost: [3000, 8000],
        lever: 1,
      },
    ],
  },
  {
    id: "vmc_presence",
    section: "interieur",
    theme: "energie",
    essential: true,
    question: "Présence d'une ventilation dans le logement ?",
    proTip:
      "VMC : bouches dans la cuisine et la salle de bain, moteur souvent en combles ou faux plafond. Simples grilles sans moteur = aération naturelle, pas une VMC.",
    input: YESNO_UNKNOWN,
    signals: [
      {
        when: "no",
        tone: "warn",
        text: "Pas de ventilation mécanique : humidité et moisissures probables, comptez 600 à 2 500 € pour équiper.",
        cost: [600, 2500],
        lever: 1,
      },
    ],
  },
  {
    id: "vmc_age",
    section: "interieur",
    theme: "energie",
    showWhen: {
      questionId: "vmc_presence",
      values: ["yes"],
    },
    question: "Arrivez-vous à estimer l'ancienneté de la ventilation ?",
    proTip:
      "Date sur le caisson, facture d'installation ou d'entretien, ou renseignement du syndic / du vendeur. Au-delà de 15 ans, une VMC peut manquer d'efficacité ou être bruyante.",
    input: {
      type: "yesno_number",
      decimals: 0,
      min: 0,
      max: 50,
      groupThousands: false,
      unit: "ans",
      detailLabel: "Ancienneté",
      placeholder: "Ex. 8",
    },
    signals: [
      {
        when: "gte:15",
        tone: "warn",
        text: "Ventilation de plus de 15 ans : remplacement ou remise en service à prévoir (600 à 2 500 €).",
        cost: [600, 2500],
        lever: 1,
      },
    ],
  },
  {
    id: "ventilation",
    section: "interieur",
    theme: "energie",
    showWhen: {
      questionId: "vmc_presence",
      values: ["yes"],
    },
    question: "La VMC aspire-t-elle bien dans la cuisine et la salle de bain ?",
    proTip:
      "Collez une feuille de papier sur chaque bouche d'extraction : elle doit rester plaquée moteur en marche. Écoutez le caisson : un ronflement faible est normal, un claquement ou une odeur de brûlé est mauvais signe.",
    input: YESNO_UNKNOWN,
    signals: [
      {
        when: "no",
        tone: "warn",
        text: "VMC faible ou en panne : risque de moisissures, 600 à 2 500 € pour remettre en service ou remplacer.",
        cost: [600, 2500],
      },
    ],
  },
  {
    id: "insulation",
    section: "interieur",
    theme: "energie",
    question: "L'isolation (murs, combles) semble-t-elle correcte ?",
    proTip: "Touchez les murs donnant sur l'extérieur : s'ils sont froids, l'isolation est faible. MaPrimeRénov' peut financer une partie des travaux.",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Isolation faible : 5 000 à 20 000 € selon la surface, aides possibles.", cost: [5000, 20000], lever: 1 }],
  },
  {
    id: "kitchen",
    section: "interieur",
    theme: "travaux",
    question: "La cuisine est-elle équipée et en bon état ?",
    proTip: "Ouvrez les placards, vérifiez la hotte et les arrivées d'eau. Une cuisine complète coûte 5 000 à 15 000 € posée.",
    photo: {
      facts: ["kitchen:partial_renovation_likely", "kitchen:full_replacement_likely"],
      hint: "Sur les photos : cuisine datée, rénovation partielle ou remplacement probable.",
    },
    input: YESNO,
    signals: [{ when: "no", tone: "info", text: "Cuisine à refaire : 5 000 à 15 000 € posée.", cost: [5000, 15000], lever: 1 }],
  },
  {
    id: "equipment_stays",
    section: "interieur",
    theme: "negociation",
    question: "Quels équipements le vendeur laisse-t-il dans le logement ?",
    proTip:
      "Four encastré, plaques, hotte et lave-vaisselle sont souvent laissés s'ils sont fixés ; le frigo, le lave-linge ou le micro-ondes seulement si le vendeur l'accepte. Faites lister ce qui reste pour l'offre et le compromis.",
    input: {
      type: "choice",
      options: [
        { value: "all_visible", label: "Tout l'encastré et l'électroménager visible" },
        { value: "kitchen_builtin", label: "Cuisine encastrée seulement (four, plaques, hotte…)" },
        { value: "partial", label: "Une partie seulement" },
        { value: "nothing", label: "Rien ne reste" },
        { value: "unclear", label: "Pas encore clarifié" },
        { value: "other", label: "Autre", other: true },
      ],
      otherPlaceholder: "Ex. four + frigo, pas le lave-linge…",
    },
    signals: [
      {
        when: "value:partial",
        tone: "info",
        text: "Inclusions partielles : notez chaque appareil et faites-le figurer par écrit avant l'offre.",
        lever: 1,
      },
      {
        when: "value:unclear",
        tone: "info",
        text: "Liste floue : exigez une liste signée ou un mail de l'agent avant le compromis.",
        lever: 1,
      },
    ],
  },
  {
    id: "bathroom",
    section: "interieur",
    theme: "travaux",
    question: "Faut-il prévoir des travaux dans la ou les salles de bain / WC ?",
    proTip:
      "Comptez chaque salle de bain, salle d'eau et WC séparément. Rafraîchir : joints, robinetterie, peinture ou retouches localisées, la pièce reste utilisable. Refaire totalement : dépose faïence, douche ou baignoire, meuble vasque, souvent plomberie et évacuations. Une pièce peut être jolie en surface et n'avoir besoin que d'un rafraîchissement.",
    photo: {
      facts: ["bathroom:medium", "bathroom:medium_to_full", "bathroom:full"],
      hint: "Sur les photos : rénovation de salle de bain probable ({rooms}).",
    },
    input: {
      type: "count_pair",
      max: 15,
      groupThousands: false,
      rows: [
        { key: "full", label: "Nombre de salles de bain à refaire totalement" },
        { key: "refresh", label: "Nombre de salles de bain à rafraîchir" },
      ],
    },
    signals: [
      {
        when: "count_gte:refresh:1",
        tone: "info",
        text: "Rafraîchissement prévu : joints, robinetterie ou retouches, 2 000 à 6 000 € par pièce.",
        cost: [2000, 6000],
        countFrom: "refresh",
        lever: 1,
      },
      {
        when: "count_gte:full:1",
        tone: "warn",
        text: "Refonte complète à budgéter : 4 000 à 12 000 € par salle de bain selon surface et finitions.",
        cost: [4000, 12000],
        countFrom: "full",
        lever: 1,
      },
    ],
  },
  {
    id: "smells",
    section: "interieur",
    theme: "travaux",
    question: "Des odeurs (humidité, tabac, égouts, cuisine du voisin) ?",
    proTip: "Le nez ne ment pas : bougies et café fraîchement moulu sont des techniques de home staging. Revenez sans prévenir si possible.",
    input: YESNO,
    signals: [{ when: "yes", tone: "warn", text: "Odeur persistante : cherchez la cause (ventilation, siphon, infiltration) avant de vous engager." }],
  },
  {
    id: "connectivity",
    section: "interieur",
    theme: "environnement",
    question: "Réseau mobile et fibre sont-ils disponibles ?",
    proTip: "Testez votre téléphone dans chaque pièce et vérifiez l'éligibilité fibre à l'adresse sur le site de l'Arcep.",
    input: YESNO,
  },

  /* ============================ 4. Les chiffres ============================ */
  {
    id: "charges_copro",
    section: "chiffres",
    theme: "copropriete",
    audience: "copro",
    field: "charges_copro",
    essential: true,
    question: "Quel est le montant réel des charges de copropriété ?",
    proTip:
      "Demandez les 3 derniers appels de charges. Distinguez les charges courantes (entretien, syndic) du fonds travaux obligatoire. Comptez-les dans votre mensualité.",
    input: {
      type: "confirm_number",
      unit: "€/an",
      decimals: 0,
      min: 0,
      max: 100000,
      unknownOption: true,
      unknownLabel: "À confirmer",
    },
    signals: [{ when: "corrected", tone: "info", text: "Charges corrigées : votre budget mensuel du bilan est recalculé." }],
  },
  {
    id: "charges_detail",
    section: "chiffres",
    theme: "copropriete",
    audience: "copro",
    question: "Qu'est-ce qui est compris dans les charges de copropriété ?",
    proTip:
      "Sur l'appel de charges ou le pré-état daté, repérez chauffage, eau chaude, eau froide, gardien, ascenseur et entretien des parties communes. Des charges élevées avec chauffage et eau chaude ne sont pas un défaut : comparez à périmètre égal.",
    input: {
      type: "choice",
      layout: "list",
      options: [
        { value: "heating_hot_water", label: "Chauffage collectif et eau chaude inclus" },
        { value: "heating_only", label: "Chauffage collectif seulement" },
        { value: "hot_water_only", label: "Eau chaude collective seulement" },
        { value: "basic", label: "Entretien, syndic et parties communes (sans chauffage ni eau)" },
        { value: "unclear", label: "Pas encore clarifié" },
        { value: "other", label: "Autre périmètre", other: true },
      ],
      otherPlaceholder: "Ex. gardien + ascenseur, pas le chauffage…",
    },
    signals: [
      {
        when: "value:heating_hot_water",
        tone: "ok",
        text: "Périmètre large : le montant annuel est comparable à une copro où vous payez chauffage et eau à part.",
      },
      {
        when: "value:basic",
        tone: "info",
        text: "Charges « de base » : ajoutez au budget le chauffage et l'eau chaude individuels (ou les appels séparés).",
      },
      {
        when: "value:unclear",
        tone: "info",
        text: "Demandez le détail ligne par ligne sur le dernier appel de charges avant de comparer avec d'autres biens.",
        lever: 1,
      },
    ],
  },
  {
    id: "copro_works_voted",
    section: "chiffres",
    theme: "copropriete",
    audience: "copro",
    essential: true,
    question: "Des travaux sont-ils votés ou à l'ordre du jour dans la copropriété ?",
    proTip:
      "Ravalement, toiture, ascenseur votés = plusieurs milliers d'euros à votre charge, même votés avant votre achat si les appels de fonds tombent après.",
    input: YESNO,
    signals: [{ when: "yes", tone: "danger", text: "Travaux votés : exigez le montant de la quote-part et qui la paie (vendeur ou acheteur) dans le compromis.", lever: 2 }],
  },
  {
    id: "copro_works_amount",
    section: "chiffres",
    theme: "copropriete",
    audience: "copro",
    question: "Montant estimé de votre quote-part des travaux votés ?",
    proTip: "Il figure dans le PV d'AG ou le pré-état daté. Négociez que les appels de fonds déjà votés restent à la charge du vendeur.",
    input: { type: "number", unit: "€", decimals: 0, min: 0, max: 500000 },
    signals: [{ when: "gte:1", tone: "warn", text: "Quote-part de travaux : à déduire de votre offre ou à faire prendre en charge par le vendeur.", lever: 1 }],
  },
  {
    id: "copro_fund",
    section: "chiffres",
    theme: "copropriete",
    audience: "copro",
    question: "Le fonds travaux (loi ALUR) est-il bien alimenté ?",
    proTip: "Il est obligatoire (5 % du budget minimum). Un fonds vide signifie que les prochains travaux seront appelés en une fois.",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "Fonds travaux vide : les prochains chantiers seront appelés en totalité auprès des copropriétaires." }],
  },
  {
    id: "copro_health",
    section: "chiffres",
    theme: "copropriete",
    audience: "copro",
    question: "La copropriété est-elle saine (pas d'impayés ni de procédure) ?",
    proTip: "Un fort taux d'impayés fragilise la copro et bloque les travaux. Le syndic doit fournir la fiche synthétique de copropriété.",
    input: YESNO,
    signals: [{ when: "no", tone: "danger", text: "Copropriété en difficulté : impayés ou procédure, risque de charges exceptionnelles. Grande prudence.", lever: 2 }],
  },
  {
    id: "copro_lots",
    section: "chiffres",
    theme: "copropriete",
    audience: "copro",
    question: "Combien de lots compte la copropriété ?",
    proTip: "Grande copro : charges fixes diluées mais décisions lentes. Petite copro : réactive mais chaque chantier pèse lourd sur chacun.",
    input: { type: "number", decimals: 0, min: 2, max: 5000 },
  },
  {
    id: "syndic_type",
    section: "chiffres",
    theme: "copropriete",
    audience: "copro",
    question: "Quel type de syndic ?",
    proTip: "Un syndic bénévole coûte moins cher mais repose sur une personne ; un professionnel facture mais sécurise les procédures.",
    input: {
      type: "choice",
      options: [
        { value: "pro", label: "Professionnel" },
        { value: "benevole", label: "Bénévole" },
        { value: "coop", label: "Coopératif" },
      ],
    },
  },
  {
    id: "taxe_fonciere",
    section: "chiffres",
    theme: "fiscalite",
    field: "taxe_fonciere",
    essential: true,
    question: "Quel est le montant de la taxe foncière ?",
    proTip:
      "Réclamez le dernier avis : c'est une charge annuelle fixe, souvent oubliée dans le budget mensuel, et elle augmente chaque année.",
    input: { type: "confirm_number", unit: "€/an", decimals: 0, min: 0, max: 100000 },
    signals: [{ when: "corrected", tone: "info", text: "Taxe foncière corrigée : votre budget mensuel du bilan est recalculé." }],
  },
  {
    id: "energy_bills",
    section: "chiffres",
    theme: "fiscalite",
    question: "Quel est le montant réel des factures d'énergie annuelles ?",
    proTip: "Le DPE donne une estimation ; demandez les vraies factures (électricité, gaz, bois) des 12 derniers mois pour un budget fiable.",
    input: { type: "number", unit: "€/an", decimals: 0, min: 0, max: 50000 },
    signals: [{ when: "gte:3000", tone: "warn", text: "Plus de 3 000 €/an d'énergie : logement énergivore, pesez des travaux d'isolation.", lever: 1 }],
  },
  {
    id: "dpe",
    section: "chiffres",
    theme: "energie",
    field: "dpe",
    essential: true,
    question: "L'étiquette DPE affichée est-elle à jour ?",
    proTip:
      "Un DPE est valable 10 ans. F et G sont des « passoires » : location interdite progressivement, gros travaux d'isolation à prévoir, et taux de crédit immobilier désormais plus élevés — servez-vous-en en négociation. Les DPE d'avant juillet 2021 ne sont plus fiables.",
    input: { type: "confirm_letter", options: ["A", "B", "C", "D", "E", "F", "G"] },
    signals: [
      {
        when: "value:F,G",
        tone: "danger",
        text: "Passoire énergétique : audit obligatoire à la vente, travaux lourds à prévoir, crédit souvent plus cher — décote et négociation justifiées.",
        cost: [15000, 40000],
        lever: 2,
      },
      { when: "value:E", tone: "warn", text: "Étiquette E : interdiction de louer prévue en 2034, pensez aux travaux à moyen terme.", lever: 1 },
    ],
  },
  {
    id: "ges",
    section: "chiffres",
    theme: "energie",
    field: "ges",
    question: "Et l'étiquette GES (émissions) ?",
    proTip: "Le GES dépend surtout du type de chauffage : fioul et gaz pèsent lourd, l'électrique et le bois peu.",
    input: { type: "confirm_letter", options: ["A", "B", "C", "D", "E", "F", "G"] },
  },
  {
    id: "dpe_recent",
    section: "chiffres",
    theme: "energie",
    question: "Le DPE date-t-il d'après juillet 2021 (nouvelle méthode) ?",
    proTip: "Les anciens DPE « sur factures » étaient souvent flatteurs. Un DPE récent est opposable : vous pouvez vous retourner contre le vendeur.",
    input: YESNO,
    signals: [{ when: "no", tone: "warn", text: "DPE ancien : demandez-en un nouveau avant l'offre, l'étiquette réelle peut être pire." }],
  },

  /* ============================ 5. Mon ressenti ============================ */
  {
    id: "crush",
    section: "ressenti",
    theme: "ressenti",
    essential: true,
    question: "Coup de cœur ? Notez votre envie d'y vivre.",
    proTip: "Notez à chaud, puis dormez dessus. Si la note tient 48 h, c'est le bon. Attention au coup de cœur qui fait oublier les défauts.",
    input: { type: "scale", min: 1, max: 5, labels: ["Non", "Bof", "Pourquoi pas", "Oui", "Coup de cœur"] },
    signals: [
      { when: "gte:5", tone: "info", text: "Coup de cœur : excellent signe, mais gardez la tête froide sur le prix et les travaux." },
      { when: "lte:2", tone: "info", text: "Peu d'envie : inutile de forcer, le bon bien ne se négocie pas avec soi-même." },
    ],
  },
  {
    id: "pros",
    section: "ressenti",
    theme: "ressenti",
    question: "Ce qui m'a plu",
    proTip: "Écrivez trois choses concrètes : elles serviront à comparer avec les autres visites.",
    input: { type: "text", placeholder: "Lumière, calme, cuisine ouverte…" },
  },
  {
    id: "cons",
    section: "ressenti",
    theme: "ressenti",
    question: "Ce qui m'a gêné",
    proTip: "Ce sont vos arguments de négociation de demain. Notez-les même s'ils semblent mineurs.",
    input: { type: "text", placeholder: "Vis-à-vis, bruit, escalier raide…" },
  },
  {
    id: "decision",
    section: "ressenti",
    theme: "ressenti",
    essential: true,
    question: "Et maintenant ?",
    proTip: "Une seconde visite à une autre heure, avec quelqu'un de confiance, vaut toujours le coup avant une offre.",
    input: {
      type: "choice",
      options: [
        { value: "offer", label: "Je fais une offre" },
        { value: "revisit", label: "Je revisite" },
        { value: "pass", label: "Je passe" },
      ],
    },
    signals: [
      { when: "value:offer", tone: "ok", text: "Prêt pour l'offre : utilisez les alertes du bilan pour justifier votre prix." },
      { when: "value:revisit", tone: "info", text: "Revisitez à une autre heure, et apportez cette fiche : il reste des points à vérifier." },
    ],
  },
  {
    id: "offer_price",
    section: "ressenti",
    theme: "negociation",
    question: "Prix que je serais prêt·e à proposer",
    proTip: "Partez des alertes chiffrées du bilan : chaque défaut repéré est un montant à soustraire du prix affiché.",
    input: { type: "number", unit: "€", decimals: 0, min: 0, max: 100000000 },
  },
];

export const QUESTION_BY_ID = Object.fromEntries(VISIT_QUESTIONS.map((q) => [q.id, q]));

/** Champs canoniques pilotables par une réponse de visite. */
export const ANSWERABLE_FIELDS = Array.from(
  new Set(VISIT_QUESTIONS.filter((q) => q.field).map((q) => q.field))
);

/** Valeur à stocker dans un champ pour une réponse (libellé pour un choix). */
function fieldValueFor(q, value) {
  if (q.input && q.input.type === "choice" && Array.isArray(q.input.options)) {
    const opt = q.input.options.find((o) => o.value === value);
    return opt ? opt.label : value;
  }
  return value;
}

/**
 * Dérive les corrections de champ (couche utilisateur) à partir des réponses.
 * Seules les questions liées à un `field` et portant une valeur produisent une
 * correction. `confirmed` = l'utilisateur a confirmé la valeur déjà connue.
 */
export function fieldsFromAnswers(answers, { origin = "visit" } = {}) {
  const fields = {};
  if (!answers || typeof answers !== "object") return fields;
  for (const [qid, ans] of Object.entries(answers)) {
    const q = QUESTION_BY_ID[qid];
    if (!q || !q.field || !ans || typeof ans !== "object") continue;
    const value = ans.value;
    if (value === null || value === undefined || value === "") continue;
    fields[q.field] = {
      value: fieldValueFor(q, value),
      source: "user",
      origin,
      confirmed: ans.response === "yes",
      updatedAt: ans.answeredAt || null,
    };
  }
  return fields;
}

/**
 * Une question s'applique-t-elle à ce bien ? `audience` « copro » vise les
 * appartements et les biens signalés en copropriété ; « house » / « apartment »
 * selon le type de bien.
 */
export function questionApplies(q, { propertyType = null, isCopro = false } = {}) {
  if (!q.audience) return true;
  const house = propertyType === "house";
  const apartment = propertyType === "apartment";
  if (q.audience === "house") return house;
  if (q.audience === "apartment") return apartment;
  if (q.audience === "copro") return !house || Boolean(isCopro);
  return true;
}

/** Un des faits photo listés par la question est-il présent ? */
export function questionHasPhotoFact(q, photoFacts) {
  const keys = q && q.photo && Array.isArray(q.photo.facts) ? q.photo.facts : [];
  if (!keys.length || !photoFacts) return false;
  return keys.some((key) => Boolean(photoFacts[key]));
}

/**
 * Une question déclenchée par l'analyse photo (`photo.required`) n'existe
 * que si un de ses faits est présent ; les autres questions passent toujours.
 */
export function questionTriggered(q, photoFacts) {
  if (!q || !q.photo || !q.photo.required) return true;
  return questionHasPhotoFact(q, photoFacts);
}
