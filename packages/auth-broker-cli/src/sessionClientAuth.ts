/**
 * How a session file's client authenticates, as the file records it:
 * one reader for every runner, so `--env` and a session `--destination` run
 * every subcommand with the client authentication the file was written with.
 *
 * - the certificate, when the file names certificate files
 *   (`SAP_UAA_CLIENT_CERT_PATH` / `_KEY_PATH`, `XSUAA_*` with `--type xsuaa`);
 * - Basic with the encoding it records (`SAP_UAA_BASIC_ENCODING`,
 *   `XSUAA_UAA_BASIC_ENCODING`);
 * - else the client secret in the request, as a run with no `--client-auth`.
 *
 * The lines are read by plain string code (`readFileVariable`).
 */

import { basicEncodingVariable, readFileVariable } from './destination';
import { UsageError } from './subcommandArgs';

/** The client authentication a session file records, and its certificate files. */
export interface SessionClientAuth {
  clientAuth?: 'certificate' | 'secret';
  basicEncoding?: 'raw' | 'form';
  /** The certificate files the file names (certificate only). */
  certPath?: string;
  keyPath?: string;
}

export function sessionClientAuth(
  file: string,
  type: 'abap' | 'xsuaa',
  flag: '--env' | '--destination',
): SessionClientAuth {
  const prefix = type === 'xsuaa' ? 'XSUAA' : 'SAP';
  const certPath = readFileVariable(file, `${prefix}_UAA_CLIENT_CERT_PATH`);
  const keyPath = readFileVariable(file, `${prefix}_UAA_CLIENT_KEY_PATH`);
  if (certPath !== undefined || keyPath !== undefined) {
    return {
      clientAuth: 'certificate',
      ...(certPath === undefined ? {} : { certPath }),
      ...(keyPath === undefined ? {} : { keyPath }),
    };
  }
  const name = basicEncodingVariable(type);
  const encoding = readFileVariable(file, name);
  if (encoding === undefined) return {};
  if (encoding !== 'raw' && encoding !== 'form') {
    throw new UsageError(`${flag}: ${name} must be raw or form`);
  }
  return { clientAuth: 'secret', basicEncoding: encoding };
}
