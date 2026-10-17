/**
 * Catalogue des tokens du design system (variables CSS de `:root` dans
 * `app/public/css/app.css`), avec le rôle de chacun.
 *
 * Affiché par la page `/admin/design-system`. Le test `design-system.test.js`
 * vérifie que chaque valeur correspond au CSS et que chaque variable de
 * `:root` est documentée ici : ajouter un token = l'ajouter dans les deux.
 */

export const COLOR_GROUPS = [
  {
    title: "Fonds",
    tokens: [
      { name: "--bg", value: "#f4f1e8", role: "Fond de page (crème). Jamais pour une carte." },
      { name: "--surface", value: "#ffffff", role: "Cartes, panneaux, champs, modales." },
      { name: "--surface-muted", value: "#f7f6f2", role: "Survol, item actif, pied de carte, bloc secondaire." },
      { name: "--surface-sunken", value: "#ebe7da", role: "Badge neutre, emplacement photo vide, zone en creux." },
    ],
  },
  {
    title: "Texte",
    tokens: [
      { name: "--ink", value: "#11150f", role: "Texte principal et titres." },
      { name: "--ink-soft", value: "#3c433a", role: "Texte secondaire, libellés de champ, bouton fantôme." },
      { name: "--ink-muted", value: "#6b7280", role: "Aides, métadonnées, légendes, compteurs." },
      { name: "--ink-inverse", value: "#f6f8f3", role: "Texte sur fond sombre ou vert profond." },
    ],
  },
  {
    title: "Marque",
    tokens: [
      { name: "--green-900", value: "#0b3d2c", role: "Couleur de marque : bouton principal, panneau vert, theme-color." },
      { name: "--green-800", value: "#12513a", role: "Survol du vert, texte d'accent, titres de repli." },
      { name: "--green-600", value: "#2e8b6b", role: "Liens, anneau de focus, bordure de champ actif." },
      { name: "--green-100", value: "#e2efe8", role: "Fond d'accent : flash succès, badge accent, survol de chevron." },
      { name: "--lime", value: "#c8f751", role: "Action positive et mise en avant : badge succès, CTA sur fond sombre." },
      { name: "--lime-dark", value: "#a8d92f", role: "Survol du lime." },
    ],
  },
  {
    title: "Sombres",
    tokens: [
      { name: "--panel", value: "#14181a", role: "Bouton sombre, pastille active, infobulle, toast, badge DPE." },
      { name: "--panel-soft", value: "#222a2c", role: "Survol du sombre." },
    ],
  },
  {
    title: "Signaux",
    tokens: [
      { name: "--warn", value: "#e0541f", role: "Avertissement, hausse de prix." },
      { name: "--warn-soft", value: "#fdeee6", role: "Fond des avertissements." },
      { name: "--danger", value: "#b42318", role: "Erreur, suppression, action irréversible." },
      { name: "--danger-soft", value: "#fdecea", role: "Fond d'erreur (flash, .form-errors, badge)." },
      { name: "--danger-vivid", value: "#dc2626", role: "Indices prix uniquement : « au-dessus du marché », scores /100." },
      { name: "--danger-vivid-soft", value: "#fee2e2", role: "Fond des indices prix défavorables." },
      { name: "--info", value: "#2563eb", role: "Information neutre (flash info, badge info)." },
      { name: "--info-soft", value: "#e8efff", role: "Fond des informations." },
    ],
  },
  {
    title: "Favoris (or)",
    tokens: [
      { name: "--gold", value: "#ffd400", role: "Favori actif, bouton « ajouter aux favoris » au survol." },
      { name: "--gold-soft", value: "#fff7b0", role: "Fond doux lié aux favoris." },
      { name: "--gold-hover", value: "#e6c419", role: "Survol de l'or." },
      { name: "--gold-ink", value: "#6b4a00", role: "Texte lisible sur fond or doux." },
      { name: "--on-gold", value: "#ffffff", role: "Icône ou texte posé sur l'or plein." },
    ],
  },
  {
    title: "Bordures",
    tokens: [
      { name: "--border", value: "#e2ded1", role: "Bordure par défaut (cartes, panneaux, séparateurs)." },
      { name: "--border-strong", value: "#cfc9b6", role: "Champs, bouton fantôme, survol de pastille." },
    ],
  },
];

export const SPACE_TOKENS = [
  { name: "--space-1", value: "4px", role: "Icône ↔ texte, écart minimal." },
  { name: "--space-2", value: "8px", role: "Entre boutons, label ↔ champ, pastilles." },
  { name: "--space-3", value: "12px", role: "Padding compact, lignes de liste." },
  { name: "--space-4", value: "16px", role: "Entre champs d'un formulaire, entre cartes, padding de carte." },
  { name: "--space-5", value: "24px", role: "Padding de panneau et de modale, sous l'en-tête de page." },
  { name: "--space-6", value: "32px", role: "Haut de page, avant la pagination." },
  { name: "--space-7", value: "48px", role: "Bas de page, état vide." },
];

export const RADIUS_TOKENS = [
  { name: "--radius-sm", value: "8px", role: "Champs, infobulle, petits contrôles." },
  { name: "--radius-md", value: "14px", role: "Flash, blocs repliables, items de menu." },
  { name: "--radius-lg", value: "20px", role: "Panneaux, cartes, modales, état vide." },
  { name: "--radius-pill", value: "999px", role: "Boutons, pastilles, badges." },
];

export const SHADOW_TOKENS = [
  {
    name: "--shadow-card",
    value: "0 1px 2px rgba(17, 21, 15, 0.04), 0 8px 24px rgba(17, 21, 15, 0.06)",
    role: "Élévation au repos : panneaux, cartes.",
  },
  {
    name: "--shadow-raised",
    value: "0 12px 32px rgba(17, 21, 15, 0.12)",
    role: "Élévation au survol et flottants : modale, infobulle, toast, menu.",
  },
];

export const FONT_TOKENS = [
  {
    name: "--font",
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    role: "Police système unique, aucune webfont.",
  },
  {
    name: "--font-mono",
    value: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    role: "Codes, identifiants, badge DPE.",
  },
];

export const LAYOUT_TOKENS = [
  { name: "--page-max", value: "1280px", role: "Largeur maximale du contenu (.page)." },
  { name: "--summary-chevron-size", value: "32px", role: "Taille du bouton chevron des blocs repliables." },
  { name: "--summary-chevron-icon", value: "8px", role: "Taille du trait du chevron." },
];

/** Tous les tokens à plat, dans l'ordre du catalogue. */
export function allDesignTokens() {
  return [
    ...COLOR_GROUPS.flatMap((group) => group.tokens),
    ...SPACE_TOKENS,
    ...RADIUS_TOKENS,
    ...SHADOW_TOKENS,
    ...FONT_TOKENS,
    ...LAYOUT_TOKENS,
  ];
}
