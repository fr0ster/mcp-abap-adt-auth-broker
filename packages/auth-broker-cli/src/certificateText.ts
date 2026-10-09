/**
 * Certificate text the CLI reads from a file or from SAML metadata — untrusted
 * input — in plain linear code: no regular expression runs over it. Whether a
 * value is a certificate at all is node:crypto's `X509Certificate` to say.
 */

import { X509Certificate } from 'node:crypto';

/**
 * Whether `character` is whitespace as a regular expression's `\s` reads it:
 * `String.prototype.trim` strips exactly that set (WhiteSpace and
 * LineTerminator), a no-break space included.
 */
export function isWhitespace(character: string): boolean {
  return character.trim() === '';
}

/** `text` without any whitespace (`\s`), in one pass. */
export function withoutWhitespace(text: string): string {
  let kept = '';
  for (const character of text) {
    if (!isWhitespace(character)) kept += character;
  }
  return kept;
}

/** Whether `character` is in the base64 alphabet (`A-Z a-z 0-9 + /`). */
function isBase64Character(character: string): boolean {
  return (
    (character >= 'A' && character <= 'Z') ||
    (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9') ||
    character === '+' ||
    character === '/'
  );
}

/**
 * Whether `text` is base64 as `/^[A-Za-z0-9+/]+={0,2}$/` read it: at least
 * one character of the alphabet, then at most two `=`, nothing else.
 */
export function isBase64Text(text: string): boolean {
  let end = text.length;
  let padding = 0;
  while (end > 0 && text[end - 1] === '=') {
    end -= 1;
    padding += 1;
  }
  if (end === 0 || padding > 2) return false;
  for (let i = 0; i < end; i++) {
    if (!isBase64Character(text[i] as string)) return false;
  }
  return true;
}

/**
 * Whether `entry` — a PEM block, or base64 DER broken by whitespace — is one
 * X.509 certificate node:crypto can read.
 */
export function isX509Certificate(entry: string): boolean {
  try {
    if (entry.includes('-----BEGIN')) {
      new X509Certificate(entry);
      return true;
    }
    const base64 = withoutWhitespace(entry);
    if (!isBase64Text(base64)) return false;
    new X509Certificate(Buffer.from(base64, 'base64'));
    return true;
  } catch {
    return false;
  }
}

/** Whether `der` is one X.509 certificate in DER. */
export function isDerCertificate(der: Buffer): boolean {
  try {
    new X509Certificate(der);
    return true;
  } catch {
    return false;
  }
}

const PEM_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_END = '-----END CERTIFICATE-----';

/**
 * Every `-----BEGIN CERTIFICATE-----` … `-----END CERTIFICATE-----` block of
 * `text`, as the lazy, global regular expression found them: each BEGIN to
 * the first END after it, the search going on after that END. One pass:
 * once a BEGIN has no END after it, no later one has either.
 */
export function pemCertificateBlocks(text: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const begin = text.indexOf(PEM_BEGIN, from);
    if (begin === -1) break;
    const end = text.indexOf(PEM_END, begin + PEM_BEGIN.length);
    if (end === -1) break;
    from = end + PEM_END.length;
    blocks.push(text.slice(begin, from));
  }
  return blocks;
}
