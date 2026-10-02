/**
 * Reading what a command wrote: the raw keys of a `.env` file, and the two
 * roles through the stores that own them.
 */

import * as fs from 'node:fs';
import {
  ABAP_DESTINATION_VARS,
  ABAP_SESSION_VARS,
  XSUAA_DESTINATION_VARS,
  XSUAA_SESSION_VARS,
} from '@mcp-abap-adt/auth-stores';

/** Every `KEY=value` of the file, quotes removed. */
export function readEnvKeys(file: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if (
      value.length >= 2 &&
      (quote === "'" || quote === '"' || quote === '`') &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    }
    keys[match[1]] = value;
  }
  return keys;
}

/** The keys a session store owns: the secret and its binding. */
export function sessionKeys(type: 'abap' | 'xsuaa'): string[] {
  return Object.values(
    type === 'abap' ? ABAP_SESSION_VARS : XSUAA_SESSION_VARS,
  ) as string[];
}

/** The keys a destination store owns: the means. */
export function meansKeys(type: 'abap' | 'xsuaa'): string[] {
  return Object.values(
    type === 'abap' ? ABAP_DESTINATION_VARS : XSUAA_DESTINATION_VARS,
  ) as string[];
}

/** The fields a session write may carry: the secret and what it is bound to. */
export const SECRET_FIELDS = [
  'authorizationToken',
  'sessionCookies',
  'expiresAt',
  'refreshToken',
  'issuedFor',
  'issuedBy',
];
