/**
 * The manual SAML login always declares its ACS: `--assertion-flow
 * manual` and the IdP-initiated paste take it from `--acs-url`, the SP
 * metadata (`--saml-metadata`, or `<uaa.url>/saml/metadata` with
 * `--service-key`) or an `acsUrl` in `--config`; with none, a usage error
 * naming `--acs-url` before anything is read or written. The 2.x fallback,
 * `http://localhost:<port>/callback`, is gone.
 *
 * Each run is `runMcpSso` end to end, its options parsed from the `mcp-auth`
 * form; the strategy the broker gets is the CLI's own, wrapped only to record
 * what it answers and to stop the login there — no assertion is validated,
 * nothing is sent to a token endpoint.
 */

/** What each strategy answered: its payload and the ACS it declared. */
const mockOutcomes: Array<{ payload: unknown; redirectUri: unknown }> = [];
/** Every readline the CLI opened. */
const mockInterfaces: Array<{ closed: boolean }> = [];

// The pasted SAMLResponse, answered here instead of a terminal.
jest.mock('node:readline', () => ({
  createInterface: () => {
    const onClose: Array<() => void> = [];
    const state = { closed: false };
    mockInterfaces.push(state);
    return {
      on: (event: string, listener: () => void) => {
        if (event === 'close') onClose.push(listener);
      },
      question: (_prompt: string, answer: (value: string) => void) =>
        answer('PASTED-SAML-RESPONSE'),
      close: () => {
        if (state.closed) return;
        state.closed = true;
        for (const listener of onClose) listener();
      },
    };
  },
}));

// The CLI's collaborators as they are, each interactive strategy recorded:
// what it answers is the test's, then the login stops.
jest.mock('../mcpSsoConfig', () => {
  const actual = jest.requireActual('../mcpSsoConfig');
  return {
    ...actual,
    buildCollaborators: (options: unknown) => {
      const own = actual.buildCollaborators(options);
      return {
        ...own,
        authorization: (destination: string, grant: string) => {
          const strategy = own.authorization(destination, grant);
          return {
            authorize: async (request: unknown) => {
              mockOutcomes.push(await strategy.authorize(request));
              throw new Error('the test stops the login here');
            },
          };
        },
      };
    },
  };
});

import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AbapSessionStore,
  EnvDestinationStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import type { McpSsoOptions } from '../mcpSsoConfig';
import { failureLines } from '../output';
import { runMcpSso } from '../runMcpSso';
import { isUsageError, parseSubcommandArgs } from '../subcommandArgs';
import { CLIENT_CRT_PATH } from './helpers/certificates';

const DEST = 'saml';
const SERVICE_URL = 'https://abap.example.com';
const ACS = 'https://abap.example.com/sap/saml2/sp/acs/100';
const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';

let root: string;
let workDir: string;
let outDir: string;
let spies: jest.SpyInstance[];
let metadataServer: http.Server;
let metadataUrl: string;
/** Every path the metadata server was asked for. */
const metadataRequests: string[] = [];

const logger: ILogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** XSUAA's SP metadata: its entityID and its bearer ACS at `alias`. */
function spMetadata(alias: string): string {
  return `<md:EntityDescriptor xmlns:md="${MD}" entityID="https://uaa.example"><md:SPSSODescriptor><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${alias}" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`;
}

beforeAll(async () => {
  // `<uaa.url>/saml/metadata` for the service-key runs, as XSUAA serves it.
  metadataServer = http.createServer((request, response) => {
    metadataRequests.push(request.url ?? '');
    if (request.url === '/authentication/saml/metadata') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(spMetadata(`${metadataUrl}/oauth/token/alias/key`));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) =>
    metadataServer.listen(0, '127.0.0.1', resolve),
  );
  const { port } = metadataServer.address() as AddressInfo;
  metadataUrl = `http://127.0.0.1:${port}/authentication`;
});

afterAll(async () => {
  metadataServer.closeAllConnections();
  await new Promise<void>((resolve) => metadataServer.close(() => resolve()));
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-acs-'));
  workDir = path.join(root, 'work');
  outDir = path.join(root, 'out');
  fs.mkdirSync(workDir);
  mockOutcomes.length = 0;
  metadataRequests.length = 0;
  mockInterfaces.length = 0;
  spies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true),
    jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

const TRUST = [
  '--idp-cert',
  CLIENT_CRT_PATH,
  '--idp-entity-id',
  'https://idp.example',
  '--idp-sso-url',
  'https://idp.example/sso',
];

/** `mcp-auth <subcommand> <args>`, parsed. */
function form(
  subcommand: 'saml2-pure' | 'saml2-bearer',
  args: string[],
): McpSsoOptions {
  const parsed = parseSubcommandArgs(subcommand, [
    '--output',
    path.join(outDir, `${DEST}.env`),
    ...TRUST,
    ...args,
  ]);
  if (parsed.kind !== 'sso') throw new Error(`not a run: ${parsed.kind}`);
  return parsed.options;
}

const run = (options: McpSsoOptions) => runMcpSso(options, { logger, workDir });

/** A pure run: the ABAP system's own ACS, stated by the user. */
function pure(flow: string[], extra: string[] = []): McpSsoOptions {
  return form('saml2-pure', [
    '--service-url',
    SERVICE_URL,
    '--sp-entity-id',
    'https://abap.example.com/sp',
    ...flow,
    ...extra,
  ]);
}

/**
 * A bearer run with its client stated by flags. Its UAA is the local
 * metadata server: a run reads `<uaa.url>/saml/metadata` whenever it has a
 * UAA URL, and an explicit `--acs-url` or `--config` ACS wins over it.
 */
function bearer(flow: string[], extra: string[] = []): McpSsoOptions {
  return form('saml2-bearer', [
    '--type',
    'xsuaa',
    '--uaa-url',
    metadataUrl,
    '--client-id',
    'bearer-client',
    '--sp-entity-id',
    'https://uaa.example',
    '--token-endpoint',
    'https://uaa.example/oauth/token/alias/flags',
    ...flow,
    ...extra,
  ]);
}

/** A bearer run with no UAA URL: no metadata, and so no ACS, to read. */
function bearerWithoutUaa(flow: string[]): McpSsoOptions {
  return form('saml2-bearer', [
    '--type',
    'xsuaa',
    '--client-id',
    'bearer-client',
    '--sp-entity-id',
    'https://uaa.example',
    '--token-endpoint',
    'https://uaa.example/oauth/token/alias/flags',
    ...flow,
  ]);
}

/** A `--config` file of `subcommand`'s protocol and flow, holding `acsUrl`. */
function configWithAcs(flow: 'pure' | 'bearer', acsUrl: string): string[] {
  const file = path.join(root, 'provider.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ protocol: 'saml2', flow, config: { acsUrl } }),
  );
  return ['--config', file];
}

const FLOWS: Array<[string, string[]]> = [
  ['--assertion-flow manual', ['--assertion-flow', 'manual']],
  ['--idp-initiated', ['--idp-initiated']],
  [
    '--idp-initiated --assertion-flow manual',
    ['--idp-initiated', '--assertion-flow', 'manual'],
  ],
];

describe('no ACS from any source: refused naming --acs-url, nothing read or written', () => {
  let storeCalls: jest.SpyInstance[];

  beforeEach(() => {
    storeCalls = [
      ...(
        [
          'setDestination',
          'getConnectionConfig',
          'getAuthorizationConfig',
        ] as const
      ).map((method) => jest.spyOn(EnvDestinationStore.prototype, method)),
      ...[AbapSessionStore, XsuaaSessionStore].flatMap((Store) =>
        (['loadSession', 'saveSession'] as const).map((method) =>
          jest.spyOn(Store.prototype, method),
        ),
      ),
    ];
    spies.push(...storeCalls);
  });

  it.each([
    ...FLOWS.map(
      ([name, flow]) => [`saml2-pure ${name}`, () => pure(flow)] as const,
    ),
    ...FLOWS.map(
      ([name, flow]) =>
        [`saml2-bearer ${name}`, () => bearerWithoutUaa(flow)] as const,
    ),
  ])('%s', async (_case, options) => {
    const thrown = await run(options()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isUsageError(thrown)).toBe(true);
    const words = failureLines(thrown).join('\n');
    expect(words).toContain('--acs-url');
    expect(words).not.toContain('localhost');
    for (const spy of storeCalls) expect(spy).not.toHaveBeenCalled();
    expect(fs.readdirSync(workDir)).toEqual([]);
    expect(fs.existsSync(outDir)).toBe(false);
    expect(mockInterfaces).toHaveLength(0);
    expect(mockOutcomes).toHaveLength(0);
  });
});

describe('no ACS from any source: refused before any metadata is fetched', () => {
  it.each([
    ...FLOWS.map(
      ([name, flow]) =>
        [
          `saml2-pure ${name}`,
          () => pure(flow, ['--idp-metadata', `${metadataUrl}/idp-metadata`]),
        ] as const,
    ),
    ...FLOWS.map(
      ([name, flow]) =>
        [
          `saml2-bearer ${name}`,
          () => ({
            ...bearerWithoutUaa(flow),
            idpMetadata: `${metadataUrl}/idp-metadata`,
          }),
        ] as const,
    ),
  ])('%s with --idp-metadata', async (_case, options) => {
    const thrown = await run(options()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isUsageError(thrown)).toBe(true);
    expect(failureLines(thrown).join('\n')).toContain('--acs-url');
    expect(metadataRequests).toEqual([]);
    expect(fs.readdirSync(workDir)).toEqual([]);
  });
});

describe("each source: the strategy's redirectUri is the ACS it states", () => {
  /** The one outcome the run's strategy answered, the login then stopped. */
  async function outcomeOf(options: McpSsoOptions) {
    const thrown = await run(options).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeDefined();
    expect(mockOutcomes).toHaveLength(1);
    return mockOutcomes[0];
  }

  describe.each(FLOWS)('%s', (_name, flow) => {
    it('--acs-url (saml2-pure)', async () => {
      await expect(outcomeOf(pure(flow, ['--acs-url', ACS]))).resolves.toEqual({
        payload: 'PASTED-SAML-RESPONSE',
        redirectUri: ACS,
      });
    });

    it('acsUrl in --config (saml2-pure)', async () => {
      await expect(
        outcomeOf(pure(flow, configWithAcs('pure', ACS))),
      ).resolves.toEqual({ payload: 'PASTED-SAML-RESPONSE', redirectUri: ACS });
    });

    it('--acs-url (saml2-bearer)', async () => {
      const acs = 'https://uaa.example/oauth/token/alias/stated';
      await expect(
        outcomeOf(bearer(flow, ['--acs-url', acs])),
      ).resolves.toEqual({ payload: 'PASTED-SAML-RESPONSE', redirectUri: acs });
    });

    it('acsUrl in --config (saml2-bearer)', async () => {
      const acs = 'https://uaa.example/oauth/token/alias/config';
      await expect(
        outcomeOf(bearer(flow, configWithAcs('bearer', acs))),
      ).resolves.toEqual({ payload: 'PASTED-SAML-RESPONSE', redirectUri: acs });
    });

    it('--saml-metadata (saml2-bearer)', async () => {
      const acs = 'https://uaa.example/oauth/token/alias/file';
      const file = path.join(root, 'sp.xml');
      fs.writeFileSync(file, spMetadata(acs));
      await expect(
        outcomeOf(bearer(flow, ['--saml-metadata', file])),
      ).resolves.toEqual({ payload: 'PASTED-SAML-RESPONSE', redirectUri: acs });
    });

    it('<uaa.url>/saml/metadata with --service-key (saml2-bearer)', async () => {
      const key = path.join(root, `${DEST}.json`);
      fs.writeFileSync(
        key,
        JSON.stringify({
          url: metadataUrl,
          clientid: 'key-client',
          clientsecret: 'key-secret',
        }),
      );
      await expect(
        outcomeOf(
          form('saml2-bearer', [
            '--type',
            'xsuaa',
            '--service-key',
            key,
            ...flow,
          ]),
        ),
      ).resolves.toEqual({
        payload: 'PASTED-SAML-RESPONSE',
        redirectUri: `${metadataUrl}/oauth/token/alias/key`,
      });
    });

    it('--acs-url wins over the --config file', async () => {
      await expect(
        outcomeOf(
          pure(flow, [
            '--acs-url',
            ACS,
            ...configWithAcs('pure', 'https://other.example/acs'),
          ]),
        ),
      ).resolves.toEqual({ payload: 'PASTED-SAML-RESPONSE', redirectUri: ACS });
    });
  });
});
