/**
 * How a service key's client authenticates to the authorization server, as
 * the user states it — shared by `mcp-auth` and `generate-env`, so both read
 * the same flags under the same rules and refuse with the same words.
 *
 * Nothing here chooses: no flag is the client secret in the token request, as
 * 2.0.0; `--client-auth secret --basic-encoding raw|form` the secret in a
 * Basic header; `--client-auth certificate --cert-path --key-path` the key's
 * x509 client, its certificate and key read from the user's own files, which
 * the destination names by path. No encoding is assumed either.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ClientAuthenticationStrategy,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
} from '@mcp-abap-adt/auth-broker';
import {
  AbapServiceKeyStore,
  XsuaaServiceKeyStore,
} from '@mcp-abap-adt/auth-stores';
import { UsageError } from './subcommandArgs';

/** The client authentication flags, as given. */
export interface ClientAuthFlags {
  /** `--client-auth`: `certificate` or `secret`; absent, the client secret as 2.0.0. */
  clientAuth?: string | undefined;
  /** `--basic-encoding`: required with `secret`, nowhere else. */
  basicEncoding?: string | undefined;
  /** `--cert-path` / `--key-path`: required with `certificate`, nowhere else. */
  certPath?: string | undefined;
  keyPath?: string | undefined;
}

/** The certificate files `--client-auth certificate` names, as absolute paths. */
export interface CertificateFiles {
  certPath: string;
  keyPath: string;
}

/** A value present as a non-empty string. */
export function present(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * The client authentication flags, checked before anything is written: each
 * flag only with the choice it belongs to, every flag that choice needs, and
 * the certificate files present — resolved to absolute paths, so the
 * destination works from wherever it is copied. A refusal names the flag.
 */
export function clientAuthFlags(
  flags: ClientAuthFlags,
): CertificateFiles | null {
  const { clientAuth } = flags;
  if (
    clientAuth !== undefined &&
    clientAuth !== 'certificate' &&
    clientAuth !== 'secret'
  ) {
    throw new UsageError(`--client-auth must be 'certificate' or 'secret'`);
  }
  if (clientAuth === 'secret') {
    if (flags.basicEncoding !== 'raw' && flags.basicEncoding !== 'form') {
      throw new UsageError(
        '--client-auth secret needs --basic-encoding raw|form: how the client id and secret are encoded depends on the server (XSUAA: raw)',
      );
    }
  } else if (flags.basicEncoding !== undefined) {
    throw new UsageError(
      '--basic-encoding applies only to --client-auth secret',
    );
  }
  const certificateFlags = [
    ['--cert-path', flags.certPath],
    ['--key-path', flags.keyPath],
  ] as const;
  if (clientAuth !== 'certificate') {
    const stray = certificateFlags.filter(([, value]) => value !== undefined);
    if (stray.length > 0) {
      throw new UsageError(
        `${stray.map(([flag]) => flag).join(' and ')} apply only to --client-auth certificate`,
      );
    }
    return null;
  }
  const missing = certificateFlags.filter(([, value]) => !present(value));
  if (missing.length > 0) {
    throw new UsageError(
      `--client-auth certificate needs ${missing.map(([flag]) => flag).join(' and ')}`,
    );
  }
  const resolveFile = ([flag, value]: (typeof certificateFlags)[number]) => {
    const resolved = path.resolve(value as string);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
      throw new UsageError(`${flag}: no file at ${resolved}`);
    }
    return resolved;
  };
  const certPath = resolveFile(certificateFlags[0]);
  const keyPath = resolveFile(certificateFlags[1]);
  return { certPath, keyPath };
}

/**
 * The user's choice as the broker's strategy; none without `--client-auth`.
 * Called only after `clientAuthFlags` accepted the flags.
 */
export function clientAuthenticationStrategy(
  flags: ClientAuthFlags,
): ClientAuthenticationStrategy | undefined {
  if (flags.clientAuth === 'certificate') {
    return fromServiceKeyCertificate();
  }
  if (flags.clientAuth === 'secret') {
    return fromServiceKeySecret({
      encoding: flags.basicEncoding as 'raw' | 'form',
    });
  }
  return undefined;
}

/**
 * Whether a service key carries a client certificate or a private key, in
 * part or whole, flat or under `uaa` — PEM the CLI must never copy. Only the
 * fields' presence is read; which client authenticates is the user's flag.
 */
export function carriesCertificate(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const uaa = (json as Record<string, unknown>).uaa;
  return [json, uaa].some(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      ((part as Record<string, unknown>).certificate !== undefined ||
        (part as Record<string, unknown>).key !== undefined),
  );
}

/**
 * The store that reads a service key: AbapServiceKeyStore for an ABAP-format
 * key (`uaa`-nested) carrying no certificate, XsuaaServiceKeyStore for every
 * other — the only store that answers a certificate client and reads a
 * `credentials`-wrapped key in place; it reads `uaa`-nested keys, `abap.url`
 * and the SAP client too, so an ABAP-format key carrying a certificate
 * answers as before. AbapServiceKeyStore refuses a key with no client secret
 * (an x509 one) outright, before the command could name the flag it needs.
 */
export function serviceKeyStoreFor(
  directory: string,
  abapFormat: boolean,
  key: unknown,
): BuiltServiceKeyStore {
  return abapFormat && !carriesCertificate(key)
    ? { kind: 'abap', store: new AbapServiceKeyStore(directory) }
    : { kind: 'xsuaa', store: new XsuaaServiceKeyStore(directory) };
}

/** The store the CLI built, and which one: recorded, never asked of the object. */
export type BuiltServiceKeyStore =
  | { kind: 'abap'; store: AbapServiceKeyStore }
  | { kind: 'xsuaa'; store: XsuaaServiceKeyStore };

/** The refusal of a key with a certificate and no secret, run with no flag. */
export function certificateNeedsFlag(destination: string): string {
  return `The service key of ${destination} carries a client certificate and no client secret: state how the client authenticates with --client-auth certificate --cert-path <path> --key-path <path>`;
}

/** The refusal of `--client-auth certificate` for a key with no certificate. */
export function noCertificateClient(destination: string): string {
  return `The service key of ${destination} carries no client certificate (url, clientid, certificate, key, certurl): --client-auth certificate needs one`;
}

/** The fields a service key's certificate client needs (auth-stores' own list). */
const CERTIFICATE_CLIENT_FIELDS: readonly string[] = [
  'url',
  'clientid',
  'certificate',
  'key',
  'certurl',
];

/**
 * The key's certificate client, through the store the CLI built for it;
 * `null` when the key holds none. A store's refusal is put in this CLI's
 * words: the fields it names, each one of `CERTIFICATE_CLIENT_FIELDS` — read
 * as an own data array and kept only when on that list — never its message.
 */
export async function readCertificateClient(
  store: XsuaaServiceKeyStore,
  destination: string,
): Promise<Awaited<ReturnType<XsuaaServiceKeyStore['getClientCertificate']>>> {
  try {
    return await store.getClientCertificate(destination);
  } catch (thrown) {
    let named: unknown;
    try {
      const descriptor =
        typeof thrown === 'object' && thrown !== null
          ? Object.getOwnPropertyDescriptor(thrown, 'variables')
          : undefined;
      named =
        descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch {
      named = undefined;
    }
    const missing = Array.isArray(named)
      ? CERTIFICATE_CLIENT_FIELDS.filter((field) => named.includes(field))
      : [];
    throw new UsageError(
      missing.length > 0
        ? `The client certificate in the service key of "${destination}" is incomplete: ${missing.join(', ')} missing`
        : `The client certificate in the service key of "${destination}" cannot be read`,
    );
  }
}
