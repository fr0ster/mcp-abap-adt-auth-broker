/**
 * The throwaway certificates under `fixtures/certificates/` and what the
 * client-certificate tests need around them: an HTTPS stand-in for an XSUAA
 * `certurl`, trusted inside the test process alone, and a scan for PEM in
 * whatever a command wrote.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { type LocalServer, startLocalServer } from './localServer';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'certificates');
export const CLIENT_CRT_PATH = path.join(FIXTURES, 'client.crt');
export const CLIENT_KEY_PATH = path.join(FIXTURES, 'client.key');
export const CLIENT_CRT = fs.readFileSync(CLIENT_CRT_PATH, 'utf8');
export const CLIENT_KEY = fs.readFileSync(CLIENT_KEY_PATH, 'utf8');
/** The subject CN of the client certificate. */
export const CLIENT_CN = 'mcp-auth-test-client';
/** What every PEM block starts with. */
export const PEM = '-----BEGIN';

/**
 * Trusts the HTTPS stand-in's certificate inside this process for the
 * enclosing `describe`, and restores the default trust after it.
 */
export function trustCertServer(): void {
  let defaultCas: string[];
  beforeAll(() => {
    defaultCas = tls.getCACertificates('default');
    tls.setDefaultCACertificates([
      ...defaultCas,
      fs.readFileSync(path.join(FIXTURES, 'server.crt'), 'utf8'),
    ]);
  });
  afterAll(() => {
    tls.setDefaultCACertificates(defaultCas);
  });
}

/** The HTTPS stand-in for `certurl`: it records the client certificate's CN. */
export function startCertServer(): Promise<LocalServer> {
  return startLocalServer({
    cert: fs.readFileSync(path.join(FIXTURES, 'server.crt'), 'utf8'),
    key: fs.readFileSync(path.join(FIXTURES, 'server.key'), 'utf8'),
  });
}

/** Every file under `dir`, recursively; none when it does not exist. */
export function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** The files under `dirs` that hold PEM. */
export function pemFilesUnder(...dirs: string[]): string[] {
  return dirs
    .flatMap(filesUnder)
    .filter((file) => fs.readFileSync(file, 'utf8').includes(PEM));
}
