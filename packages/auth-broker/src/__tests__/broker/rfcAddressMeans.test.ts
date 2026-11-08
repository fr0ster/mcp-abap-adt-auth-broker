/**
 * The RFC address passes the broker: `getConnectionConfig` answers each of
 * the seven address means (`ashost`, `sysnr`, `mshost`, `msserv`, `sysid`,
 * `group`, `saprouter`) exactly as a real `EnvDestinationStore`
 * (auth-stores 5.1.0) reads it from a destination file — with the ABAP
 * variable names (`SAP_…`) and the XSUAA ones (`XSUAA_…`). The broker forwards
 * every non-secret means field the key store answers; nothing here is new
 * code, it is the behaviour the RFC address relies on.
 *
 * The files are written by hand, as a consumer writes them; the session store
 * is a real `AbapSessionStore` over an empty directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AbapSessionStore,
  EnvDestinationStore,
  XSUAA_DESTINATION_VARS,
} from '@mcp-abap-adt/auth-stores';
import { AuthBroker } from '../../index';
import { STATED } from '../helpers/stated';

const D = 'RFC';

/** Each address means, its variable suffix and a value of its own. */
const ADDRESS = [
  ['ashost', 'ASHOST', 'app-server.example.com'],
  ['sysnr', 'SYSNR', '07'],
  ['mshost', 'MSHOST', 'message-server.example.com'],
  ['msserv', 'MSSERV', 'sapmsE19'],
  ['sysid', 'SYSID', 'E19'],
  ['group', 'GROUP', 'SPACE'],
  ['saprouter', 'SAPROUTER', '/H/router.example.com/S/3299/H/'],
] as const;

const SETS = [
  { name: 'ABAP', prefix: 'SAP_', variables: undefined },
  { name: 'XSUAA', prefix: 'XSUAA_', variables: XSUAA_DESTINATION_VARS },
] as const;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-rfc-address-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function brokerOver(
  lines: readonly string[],
  variables: (typeof SETS)[number]['variables'],
): AuthBroker {
  const keys = path.join(dir, 'keys');
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(path.join(keys, `${D}.env`), `${lines.join('\n')}\n`);
  return new AuthBroker({
    ...STATED,
    sessionStore: new AbapSessionStore(path.join(dir, 'sessions')),
    serviceKeyStore: new EnvDestinationStore(keys, { variables }),
  });
}

describe.each(SETS)('$name variables', ({ prefix, variables }) => {
  it.each(ADDRESS)(
    'getConnectionConfig answers %s as the store reads it',
    async (field, suffix, value) => {
      const broker = brokerOver(
        [
          `${prefix}AUTH_TYPE=basic`,
          `${prefix}CLIENT=100`,
          `${prefix}LANGUAGE=EN`,
          `${prefix}${suffix}=${value}`,
        ],
        variables,
      );

      expect(await broker.getConnectionConfig(D)).toEqual({
        authType: 'basic',
        sapClient: '100',
        language: 'EN',
        [field]: value,
      });
    },
  );

  it('getConnectionConfig answers all seven together, each as stated', async () => {
    const broker = brokerOver(
      [
        `${prefix}AUTH_TYPE=snc`,
        `${prefix}CLIENT=100`,
        `${prefix}LANGUAGE=EN`,
        ...ADDRESS.map(([, suffix, value]) => `${prefix}${suffix}=${value}`),
      ],
      variables,
    );

    expect(await broker.getConnectionConfig(D)).toEqual({
      authType: 'snc',
      sapClient: '100',
      language: 'EN',
      ...Object.fromEntries(ADDRESS.map(([field, , value]) => [field, value])),
    });
  });
});
