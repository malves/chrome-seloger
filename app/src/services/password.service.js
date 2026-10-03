/**
 * Hachage des mots de passe.
 *
 * Unique point d'appel à argon2 : remplacer la bibliothèque (par exemple par
 * `@node-rs/argon2`, qui expose la même API et ne demande pas de compilateur)
 * ne touche que ce fichier.
 */

import argon2 from "argon2";

export function hashPassword(plain) {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Hash corrompu ou algorithme inconnu : on refuse sans détail.
    return false;
  }
}
