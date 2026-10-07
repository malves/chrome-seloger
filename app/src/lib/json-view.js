/**
 * Arbre JSON interactif (HTML sûr) pour l'inspecteur de cache admin.
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrimitive(value) {
  if (value === null) {
    return '<span class="jv-null">null</span>';
  }
  if (typeof value === "boolean") {
    return `<span class="jv-bool">${value}</span>`;
  }
  if (typeof value === "number") {
    return `<span class="jv-num">${Number.isFinite(value) ? value : escapeHtml(String(value))}</span>`;
  }
  if (typeof value === "string") {
    return `<span class="jv-str">"${escapeHtml(value)}"</span>`;
  }
  return `<span class="jv-unknown">${escapeHtml(String(value))}</span>`;
}

function branchSummary(value) {
  if (Array.isArray(value)) {
    return `[ ${value.length} élément${value.length > 1 ? "s" : ""} ]`;
  }
  if (value && typeof value === "object") {
    const n = Object.keys(value).length;
    return `{ ${n} clé${n > 1 ? "s" : ""} }`;
  }
  return "";
}

function encodePath(path) {
  return encodeURIComponent(path);
}

function renderBranch(value, path, depth) {
  if (value === null || typeof value !== "object") {
    return `<div class="jv-entry jv-entry--leaf" data-jv-path="${escapeHtml(path)}" data-jv-depth="${depth}">
      <div class="jv-line">
        <span class="jv-toggle jv-toggle--spacer" aria-hidden="true"></span>
        <span class="jv-value">${formatPrimitive(value)}</span>
      </div>
    </div>`;
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const open = depth < 2 ? " is-open" : "";
  const summary = branchSummary(value);

  const children = entries
    .map(([key, child]) => {
      const childPath = isArray ? `${path}[${key}]` : `${path}.${key}`;
      const label = isArray
        ? `<span class="jv-index">[${escapeHtml(key)}]</span>`
        : `<span class="jv-key">${escapeHtml(key)}</span>`;
      const childIsBranch = child !== null && typeof child === "object";
      if (!childIsBranch) {
        return `<div class="jv-entry jv-entry--leaf" data-jv-path="${escapeHtml(childPath)}" data-jv-depth="${depth + 1}">
          <div class="jv-line">
            <span class="jv-toggle jv-toggle--spacer" aria-hidden="true"></span>
            ${label}<span class="jv-colon">:</span>
            <span class="jv-value">${formatPrimitive(child)}</span>
          </div>
        </div>`;
      }
      return `<div class="jv-entry jv-entry--branch" data-jv-path="${escapeHtml(childPath)}" data-jv-depth="${depth + 1}">
        <div class="jv-line jv-line--head">
          <button type="button" class="jv-toggle${depth < 2 ? " is-open" : ""}" aria-expanded="${depth < 2 ? "true" : "false"}" data-jv-toggle aria-label="Déplier / replier"></button>
          ${label}<span class="jv-colon">:</span>
          <span class="jv-meta">${escapeHtml(summary)}</span>
        </div>
        <div class="jv-children${depth < 2 ? " is-open" : ""}" data-jv-children>
          ${renderBranch(child, childPath, depth + 1)}
        </div>
      </div>`;
    })
    .join("");

  if (depth === 0) {
    return `<div class="jv-root jv-branch jv-entry${open}" data-jv-path="${escapeHtml(path)}" data-jv-depth="${depth}">
      <div class="jv-line jv-line--head">
        <button type="button" class="jv-toggle is-open" aria-expanded="true" data-jv-toggle aria-label="Déplier / replier"></button>
        <span class="jv-meta jv-meta--root">${escapeHtml(summary)}</span>
      </div>
      <div class="jv-children is-open" data-jv-children>${children}</div>
    </div>`;
  }

  return children;
}

/** @param {unknown} value */
export function buildJsonViewHtml(value) {
  if (value === undefined) {
    return '<p class="jv-empty">Aucune donnée JSON.</p>';
  }
  return renderBranch(value, "root", 0);
}

export function jsonForClipboard(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export { escapeHtml };
