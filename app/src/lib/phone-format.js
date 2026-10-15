/**
 * Formatage progressif des numéros français (06…, 00 33…, +33…).
 * Partagé entre le serveur et le navigateur (`/public/js/phone-format.js`).
 */

export function phoneDigits(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

/** Groupes 2 par 2 : 0610936557 → 06 10 93 65 57 */
function formatNationalPhoneDigits(digits) {
  digits = digits.slice(0, 10);
  if (!digits) return "";
  const parts = [];
  for (let i = 0; i < digits.length; i += 2) {
    parts.push(digits.slice(i, i + 2));
  }
  return parts.join(" ");
}

/** Neuf chiffres après indicatif : 610936557 → 6 10 93 65 57 */
function formatIntlNationalDigits(digits) {
  digits = digits.slice(0, 9);
  if (!digits) return "";
  const head = digits.charAt(0);
  const tail = digits.slice(1);
  if (!tail) return head;
  const pairs = [];
  for (let j = 0; j < tail.length; j += 2) {
    pairs.push(tail.slice(j, j + 2));
  }
  return `${head} ${pairs.join(" ")}`;
}

/**
 * Espaces pour 06…, 00 33… ou +33… (saisie progressive incluse).
 */
export function formatPhone(value) {
  const raw = String(value == null ? "" : value);
  if (!raw.trim()) return "";

  const digits = phoneDigits(raw);
  const leadPlus = /^\s*\+/.test(raw);

  if (leadPlus) {
    if (!digits) return "+";
    if (digits.indexOf("33") !== 0) {
      return `+${digits}`;
    }
    let intlNat = digits.slice(2);
    while (intlNat.charAt(0) === "0") intlNat = intlNat.slice(1);
    if (digits.length <= 2) return `+${digits}`;
    const intlBody = formatIntlNationalDigits(intlNat);
    return `+33${intlBody ? ` ${intlBody}` : ""}`;
  }

  if (digits.indexOf("0033") === 0) {
    let nat00 = digits.slice(4);
    while (nat00.charAt(0) === "0") nat00 = nat00.slice(1);
    if (digits.length <= 2) return digits;
    if (digits.length === 3) return `${digits.slice(0, 2)} ${digits.charAt(2)}`;
    if (digits.length === 4) return `00 ${digits.charAt(2)}${digits.charAt(3)}`;
    const body00 = formatIntlNationalDigits(nat00);
    return `00 33${body00 ? ` ${body00}` : ""}`;
  }

  if (digits.indexOf("00") === 0 && digits.indexOf("0033") !== 0) {
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)} ${digits.slice(2)}`;
  }

  return formatNationalPhoneDigits(digits);
}

/** Vrai si le numéro contient assez de chiffres pour être exploitable. */
export function isPhoneComplete(value) {
  const digits = phoneDigits(value);
  if (!digits) return true;
  if (digits.startsWith("33")) return digits.length >= 11;
  if (digits.startsWith("0033")) return digits.length >= 13;
  return digits.length >= 10;
}
