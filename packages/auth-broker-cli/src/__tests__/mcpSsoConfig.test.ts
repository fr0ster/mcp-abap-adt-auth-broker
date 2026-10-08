/**
 * Coverage for the CLI/config merge in mcpSsoConfig.ts, and for what a run
 * states: the destination's means and the collaborators it hands the broker.
 *
 * This is the code `mcp-sso` uses to reconcile `--protocol`/`--flow`/flag
 * options with an optional `--config <path.json>` file before building the
 * destination and the strategies the broker's provider will use. A
 * `browser`/`redirectPort`/`authorizationCode`/`assertionFlow` serialized in
 * the file must reach the strategy, a CLI flag overrides it, and every legacy
 * field either converts or refuses — never neither.
 */

const oidcCallbackStrategy = jest.fn((options: unknown) => ({
  __kind: 'oidcCallbackStrategy',
  options,
}));
const samlCallbackStrategy = jest.fn((options: unknown) => ({
  __kind: 'samlCallbackStrategy',
  options,
}));
const staticCodeStrategy = jest.fn((options: unknown) => ({
  __kind: 'staticCodeStrategy',
  options,
}));
const manualSamlResponseStrategy = jest.fn((options: unknown) => ({
  __kind: 'manualSamlResponseStrategy',
  options,
}));
const manualPasscodeStrategy = jest.fn((options: unknown) => ({
  __kind: 'manualPasscodeStrategy',
  options,
}));
const asOidcResult = jest.fn((inner: unknown) => ({
  __kind: 'asOidcResult',
  inner,
}));
// The collaborators auth-providers 5 no longer defaults: each records what it
// was built from, so a test can tell which one a config carries.
const consoleDeviceCodePresenter = jest.fn((logger: unknown) => ({
  __kind: 'consoleDeviceCodePresenter',
  logger,
}));
const defaultReplayStore = { __kind: 'defaultReplayStore' };

jest.mock('@mcp-abap-adt/auth-providers', () => ({
  DEFAULT_CALLBACK_PORT: 61001,
  oidcCallbackStrategy: (...args: unknown[]) =>
    (oidcCallbackStrategy as any)(...args),
  samlCallbackStrategy: (...args: unknown[]) =>
    (samlCallbackStrategy as any)(...args),
  staticCodeStrategy: (...args: unknown[]) =>
    (staticCodeStrategy as any)(...args),
  manualSamlResponseStrategy: (...args: unknown[]) =>
    (manualSamlResponseStrategy as any)(...args),
  manualPasscodeStrategy: (...args: unknown[]) =>
    (manualPasscodeStrategy as any)(...args),
  asOidcResult: (...args: unknown[]) => (asOidcResult as any)(...args),
  consoleDeviceCodePresenter: (...args: unknown[]) =>
    (consoleDeviceCodePresenter as any)(...args),
  defaultReplayStore,
  // The six browser factories: descriptions only, nothing is launched.
  linuxDefaultBrowser: () => ({ __kind: 'linuxDefaultBrowser' }),
  linuxBrowser: (program: string) => ({ __kind: 'linuxBrowser', program }),
  macDefaultBrowser: () => ({ __kind: 'macDefaultBrowser' }),
  macBrowser: (program: string) => ({ __kind: 'macBrowser', program }),
  windowsDefaultBrowser: () => ({ __kind: 'windowsDefaultBrowser' }),
  windowsBrowser: (program: string) => ({ __kind: 'windowsBrowser', program }),
}));

// The IdP-initiated strategy reads the pasted SAMLResponse through
// readManualInput; answer it here instead of waiting on a terminal.
const pastedInput: { value: string | null | undefined } = {
  value: 'PASTED-SAML-RESPONSE',
};
// Every interface created, and whether it was closed — a readline left open
// holds stdin and keeps the process alive.
const interfaces: Array<{ closed: boolean }> = [];
// Like the real interface, `close()` emits 'close'. `null` stands for a
// closed stdin: the question is never answered and the stream just ends.
// `undefined` stands for a terminal nobody types at: no answer, no end.
jest.mock('node:readline', () => ({
  createInterface: () => {
    const onClose: Array<() => void> = [];
    const state = { closed: false };
    interfaces.push(state);
    return {
      on: (event: string, listener: () => void) => {
        if (event === 'close') onClose.push(listener);
      },
      question: (_prompt: string, answer: (value: string) => void) => {
        if (pastedInput.value === undefined) return;
        if (pastedInput.value === null) {
          for (const listener of onClose) listener();
          return;
        }
        answer(` ${pastedInput.value} `);
      },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        for (const listener of onClose) listener();
      },
    };
  },
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import {
  applyFileConfig,
  buildCollaborators,
  buildDestinationMeans,
  type McpSsoOptions,
  normalizeProviderConfig,
  parseSamlTrustArg,
  readIdpCertificateFile,
  readManualInput,
  SamlTrustMissingError,
  ssoBrowser,
} from '../mcpSsoConfig';
import { failureLines } from '../output';
import { isUsageError } from '../subcommandArgs';

// Trust for a SAML config whose test is about something else: since
// auth-providers 5 the CLI builds the validator, and refuses without trust.
const FILE_TRUST = {
  idpCertificates: [
    '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
  ],
  idpEntityId: 'https://idp.example/metadata',
};

function baseOptions(overrides: Partial<McpSsoOptions> = {}): McpSsoOptions {
  return {
    authType: 'xsuaa',
    format: 'env',
    ...overrides,
  };
}

const silentLogger: ILogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

/**
 * What a run hands the broker, as the broker uses it: each collaborator is
 * called for the grant the destination states — the destination's means are
 * built first, as `runMcpSso` does, so a required field still refuses.
 */
function collaboratorsOf(options: McpSsoOptions) {
  buildDestinationMeans(options);
  return buildCollaborators(options);
}

/** The interactive strategy the broker gets for this run's grant. */
function strategyOf(options: McpSsoOptions): unknown {
  const collaborators = collaboratorsOf(options);
  if (options.protocol === 'oidc' && options.flow === 'browser') {
    return collaborators.oidcAuthorization('dest');
  }
  return collaborators.authorization(
    'dest',
    options.flow === 'pure' ? 'saml2_pure' : 'saml2_bearer',
  );
}

describe('mcp-sso CLI/config merge', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Real process.exit never returns; a mock that does would let code after
    // it keep running and hide exactly the kind of silent-fallthrough bug
    // this suite exists to catch. Throwing reproduces that "never returns"
    // contract inside the test process.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('config-file-only run', () => {
    it('produces a strategy carrying the file port when no CLI flags are given', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'oidc',
        flow: 'browser',
        clientId: 'file-client',
        issuerUrl: 'https://issuer.example',
        redirectPort: 4001,
        browser: 'chrome',
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);

      expect(options.protocol).toBe('oidc');
      expect(options.flow).toBe('browser');
      expect(options.clientId).toBe('file-client');

      strategyOf(options);

      expect(oidcCallbackStrategy).toHaveBeenCalledTimes(1);
      expect(oidcCallbackStrategy).toHaveBeenCalledWith(
        // The file's name, mapped by the CLI's table for this platform.
        expect.objectContaining({
          port: 4001,
          browser: ssoBrowser({ browser: 'chrome' }),
        }),
      );
    });
  });

  describe('CLI flag overriding the file', () => {
    it('a --redirect-port flag wins over the file port', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'oidc',
        flow: 'browser',
        clientId: 'file-client',
        issuerUrl: 'https://issuer.example',
        redirectPort: 4001,
      });

      // Simulates parseArgs() having already set redirectPort from
      // --redirect-port before applyFileConfig runs.
      const options = baseOptions({ redirectPort: 9999 });
      applyFileConfig(options, fileConfig);

      expect(options.redirectPort).toBe(9999);

      strategyOf(options);

      expect(oidcCallbackStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ port: 9999 }),
      );
    });

    it('a --client-id flag wins over the file clientId', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'oidc',
        flow: 'device',
        clientId: 'file-client',
        issuerUrl: 'https://issuer.example',
      });

      const options = baseOptions({ clientId: 'cli-client' });
      applyFileConfig(options, fileConfig);

      expect(options.clientId).toBe('cli-client');
    });
  });

  describe('required fields validated against the merged result', () => {
    it('a required field missing from both CLI and file still fails clearly', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'oidc',
        flow: 'browser',
        issuerUrl: 'https://issuer.example',
        // no clientId anywhere
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);

      expect(() => strategyOf(options)).toThrow('process.exit(1)');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--client-id'),
      );
    });

    it('a required field present only in the file is enough (no re-supply demanded)', () => {
      // The regression this specifically closes: requireOption used to run
      // against CLI-only options, before the file was ever merged in, so
      // --config ... --protocol oidc --flow browser demanded credentials
      // already present in the file.
      const fileConfig = normalizeProviderConfig({
        protocol: 'oidc',
        flow: 'browser',
        clientId: 'file-client',
        issuerUrl: 'https://issuer.example',
      });

      const options = baseOptions({ protocol: 'oidc', flow: 'browser' });
      applyFileConfig(options, fileConfig);

      expect(() => strategyOf(options)).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('legacy fields: convert or refuse, never neither', () => {
    it('converts a legacy `browser` field into the strategy', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'saml2',
        flow: 'bearer',
        idpSsoUrl: 'https://idp.example/sso',
        spEntityId: 'sp-entity',
        uaaUrl: 'https://uaa.example',
        clientId: 'bearer-client',
        browser: 'firefox',
        ...FILE_TRUST,
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);
      strategyOf(options);

      expect(samlCallbackStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          browser: ssoBrowser({ browser: 'firefox' }),
        }),
      );
    });

    it('converts a legacy `redirectPort` field into the strategy', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'saml2',
        flow: 'bearer',
        idpSsoUrl: 'https://idp.example/sso',
        spEntityId: 'sp-entity',
        uaaUrl: 'https://uaa.example',
        clientId: 'bearer-client',
        redirectPort: 5005,
        ...FILE_TRUST,
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);
      strategyOf(options);

      expect(samlCallbackStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ port: 5005 }),
      );
    });

    it('converts a legacy `authorizationCode` field into a static-code strategy', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'oidc',
        flow: 'browser',
        clientId: 'file-client',
        issuerUrl: 'https://issuer.example',
        authorizationCode: 'legacy-code-value',
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);

      expect(options.code).toBe('legacy-code-value');

      strategyOf(options);

      expect(staticCodeStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ payload: 'legacy-code-value' }),
      );
      expect(asOidcResult).toHaveBeenCalled();
      // The browser callback path must NOT also fire for this run.
      expect(oidcCallbackStrategy).not.toHaveBeenCalled();
    });

    it('converts a legacy `assertionFlow: manual` field into the manual strategy', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'saml2',
        flow: 'pure',
        idpSsoUrl: 'https://idp.example/sso',
        spEntityId: 'sp-entity',
        // auth-providers 6.0.0: a manual SAML login needs the ACS stated.
        acsUrl: 'https://abap.example/sap/saml2/sp/acs',
        assertionFlow: 'manual',
        ...FILE_TRUST,
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);
      strategyOf(options);

      expect(manualSamlResponseStrategy).toHaveBeenCalledTimes(1);
      expect(samlCallbackStrategy).not.toHaveBeenCalled();
    });

    it.each([
      ['authorizationCodeProvider'],
      ['assertionProvider'],
      ['manualInput'],
    ])('refuses a legacy `%s` field rather than dropping it', (field) => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'oidc',
        flow: 'browser',
        clientId: 'file-client',
        [field]: true,
      });

      const options = baseOptions();

      expect(() => applyFileConfig(options, fileConfig)).toThrow(
        'process.exit(1)',
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(field));
    });
  });

  describe('collaborators auth-providers 5 requires explicitly', () => {
    const logger: ILogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };

    // A read that never settles must not leave the next test's stdin silent.
    afterEach(() => {
      pastedInput.value = 'PASTED-SAML-RESPONSE';
    });

    it('the device flow gets the console presenter with no logger: the code always on stderr', () => {
      const collaborators = collaboratorsOf(
        baseOptions({
          protocol: 'oidc',
          flow: 'device',
          clientId: 'cli-client',
          issuerUrl: 'https://issuer.example',
        }),
      );
      expect(collaborators.deviceCodePresenter('dest')).toEqual({
        __kind: 'consoleDeviceCodePresenter',
        logger: undefined,
      });
      expect(consoleDeviceCodePresenter).toHaveBeenCalledWith();
    });

    it('states every collaborator the broker may ask for; the broker supplies none', () => {
      const collaborators = collaboratorsOf(
        baseOptions({
          protocol: 'oidc',
          flow: 'device',
          clientId: 'cli-client',
          issuerUrl: 'https://issuer.example',
        }),
      );
      expect(Object.keys(collaborators).sort()).toEqual([
        'assertionReplayStore',
        'authorization',
        'deviceCodePresenter',
        'oidcAuthorization',
        'samlCookies',
      ]);
      // The SAML validators share the process-wide replay store.
      expect(collaborators.assertionReplayStore('dest')).toBe(
        defaultReplayStore,
      );
      expect(typeof collaborators.samlCookies('dest')).toBe('function');
      // mcp-sso states no authorization_code destination: mcp-auth does.
      expect(() =>
        collaborators.authorization('dest', 'authorization_code'),
      ).toThrow('no interactive strategy for authorization_code');
    });

    it('the passcode grant gets --passcode as a static code, else a manual read that honours the signal', async () => {
      const given = collaboratorsOf(
        baseOptions({
          protocol: 'oidc',
          flow: 'password',
          uaaUrl: 'https://uaa.example',
          clientId: 'cf',
          passcode: 'ONE-TIME',
        }),
      );
      expect(given.authorization('dest', 'passcode')).toEqual({
        __kind: 'staticCodeStrategy',
        options: { payload: 'ONE-TIME' },
      });

      const asked = collaboratorsOf(
        baseOptions({
          protocol: 'oidc',
          flow: 'password',
          uaaUrl: 'https://uaa.example',
          clientId: 'cf',
        }),
      );
      asked.authorization('dest', 'passcode');
      const { read } = manualPasscodeStrategy.mock.calls[0]![0] as {
        read: (prompt: string, signal: AbortSignal) => Promise<string>;
      };
      pastedInput.value = undefined;
      const controller = new AbortController();
      const rejected = expect(
        read('Passcode: ', controller.signal),
      ).rejects.toThrow('input abandoned at "Passcode:"');
      controller.abort();
      await rejected;
    });

    it("the manual SAML strategy's read passes the strategy's signal on", async () => {
      strategyOf(
        baseOptions({
          protocol: 'saml2',
          flow: 'pure',
          authType: 'abap',
          idpSsoUrl: 'https://idp.example/sso',
          spEntityId: 'sp-entity',
          acsUrl: 'https://abap.example/sap/saml2/sp/acs',
          assertionFlow: 'manual',
          ...FILE_TRUST,
        }),
      );
      const { read } = manualSamlResponseStrategy.mock.calls[0]![0] as {
        read: (prompt: string, signal: AbortSignal) => Promise<string>;
      };
      pastedInput.value = undefined;
      const controller = new AbortController();
      const reading = read('Paste: ', controller.signal);
      const rejected = expect(reading).rejects.toThrow(
        'input abandoned at "Paste:"',
      );
      controller.abort();
      await rejected;
    });
  });

  describe('SAML trust options (auth-providers 4)', () => {
    const PEM_A =
      '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    const PEM_B =
      '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----';
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sso-trust-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function writeFile(name: string, content: string | Buffer): string {
      const filePath = path.join(tempDir, name);
      fs.writeFileSync(filePath, content);
      return filePath;
    }

    function samlOptions(
      flow: 'bearer' | 'pure',
      overrides: Partial<McpSsoOptions> = {},
    ): McpSsoOptions {
      return baseOptions({
        protocol: 'saml2',
        flow,
        authType: flow === 'pure' ? 'abap' : 'xsuaa',
        idpSsoUrl: 'https://idp.example/sso',
        spEntityId: 'sp-entity',
        // bearer's client: the token endpoint's UAA and client id.
        uaaUrl: 'https://uaa.example',
        clientId: 'bearer-client',
        ...overrides,
      });
    }

    /** The means a SAML run writes, and the strategy the broker gets for it. */
    function samlMeansOf(options: McpSsoOptions): Record<string, unknown> {
      return buildDestinationMeans(options) as Record<string, unknown>;
    }

    function samlStrategyOf(options: McpSsoOptions): {
      authorize: (request: unknown) => Promise<unknown>;
    } {
      return strategyOf(options) as never;
    }

    describe('parsing', () => {
      it('collects every --idp-cert, in order, and consumes its value', () => {
        const target: Partial<McpSsoOptions> = {};
        expect(parseSamlTrustArg(target, '--idp-cert', 'a.pem')).toBe(1);
        expect(parseSamlTrustArg(target, '--idp-cert', 'b.pem')).toBe(1);
        expect(target.idpCertificateFiles).toEqual(['a.pem', 'b.pem']);
      });

      it('reads --idp-entity-id and --authn-request-id as values', () => {
        const target: Partial<McpSsoOptions> = {};
        expect(
          parseSamlTrustArg(target, '--idp-entity-id', 'https://idp/meta'),
        ).toBe(1);
        expect(parseSamlTrustArg(target, '--authn-request-id', '_req1')).toBe(
          1,
        );
        expect(target).toEqual({
          idpEntityId: 'https://idp/meta',
          authnRequestId: '_req1',
        });
      });

      it('--idp-initiated is a flag: it consumes no value', () => {
        const target: Partial<McpSsoOptions> = {};
        expect(parseSamlTrustArg(target, '--idp-initiated', '--output')).toBe(
          0,
        );
        expect(target.idpInitiated).toBe(true);
      });

      it('leaves idpInitiated undefined when the flag is absent', () => {
        const target: Partial<McpSsoOptions> = {};
        expect(parseSamlTrustArg(target, '--output', 'x.env')).toBe(0);
        expect(target).toEqual({});
      });

      it.each([[undefined], ['--output']])(
        'refuses --idp-cert followed by %p',
        (next) => {
          expect(() => parseSamlTrustArg({}, '--idp-cert', next)).toThrow(
            'process.exit(1)',
          );
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('--idp-cert'),
          );
        },
      );
    });

    describe('certificate files', () => {
      it('splits a PEM bundle into one entry per certificate', () => {
        const file = writeFile('bundle.pem', `${PEM_A}\n${PEM_B}\n`);
        expect(readIdpCertificateFile(file)).toEqual([PEM_A, PEM_B]);
      });

      it('passes bare base64 DER through, trimmed', () => {
        const file = writeFile('cert.b64', '  MIIBAAAA\n  ');
        expect(readIdpCertificateFile(file)).toEqual(['MIIBAAAA']);
      });

      it('base64-encodes a binary DER file', () => {
        const der = Buffer.from([0x30, 0x82, 0x01, 0xff, 0x00, 0xa0]);
        const file = writeFile('cert.der', der);
        expect(readIdpCertificateFile(file)).toEqual([der.toString('base64')]);
      });

      it('refuses a certificate file that does not exist', () => {
        expect(() =>
          readIdpCertificateFile(path.join(tempDir, 'missing.pem')),
        ).toThrow('process.exit(1)');
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('missing.pem'),
        );
      });
    });

    describe('file-config backfill', () => {
      it('fills idpCertificates, idpEntityId, idpInitiated, authnRequestId from the file', () => {
        const options = baseOptions();
        applyFileConfig(
          options,
          normalizeProviderConfig({
            protocol: 'saml2',
            flow: 'bearer',
            idpCertificates: [PEM_A, PEM_B],
            idpEntityId: 'https://idp/meta',
            idpInitiated: false,
            authnRequestId: '_file-req',
          }),
        );
        expect(options).toEqual(
          expect.objectContaining({
            idpCertificates: [PEM_A, PEM_B],
            idpEntityId: 'https://idp/meta',
            idpInitiated: false,
            authnRequestId: '_file-req',
          }),
        );
      });

      it('accepts a single certificate string', () => {
        const options = baseOptions();
        applyFileConfig(
          options,
          normalizeProviderConfig({
            protocol: 'saml2',
            flow: 'pure',
            idpCertificates: PEM_A,
          }),
        );
        expect(options.idpCertificates).toEqual([PEM_A]);
      });

      it('CLI flags win: --idp-entity-id and --idp-initiated over the file', () => {
        const options = baseOptions({
          idpEntityId: 'cli-idp',
          idpInitiated: true,
        });
        applyFileConfig(
          options,
          normalizeProviderConfig({
            protocol: 'saml2',
            flow: 'bearer',
            idpEntityId: 'file-idp',
            idpInitiated: false,
          }),
        );
        expect(options.idpEntityId).toBe('cli-idp');
        expect(options.idpInitiated).toBe(true);
      });

      it('an --idp-cert replaces the file certificates rather than adding to them', () => {
        const options = baseOptions({ idpCertificateFiles: ['cli.pem'] });
        applyFileConfig(
          options,
          normalizeProviderConfig({
            protocol: 'saml2',
            flow: 'bearer',
            idpCertificates: [PEM_A],
          }),
        );
        expect(options.idpCertificates).toBeUndefined();
        expect(options.idpCertificateFiles).toEqual(['cli.pem']);
      });

      it.each([
        ['idpInitiated', 'true'],
        ['idpCertificates', 42],
        ['idpCertificates', [PEM_A, 7]],
      ])('refuses %s of the wrong type (%p)', (field, value) => {
        expect(() =>
          applyFileConfig(
            baseOptions(),
            normalizeProviderConfig({
              protocol: 'saml2',
              flow: 'bearer',
              [field]: value,
            }),
          ),
        ).toThrow('process.exit(1)');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(field));
      });
    });

    describe.each([['bearer' as const], ['pure' as const]])(
      'into the %s destination',
      (flow) => {
        it('states every certificate — inline and from files — and the entity id; the broker builds the validator', () => {
          const file = writeFile('rotated.pem', PEM_B);
          const means = samlMeansOf(
            samlOptions(flow, {
              idpCertificates: [PEM_A],
              idpCertificateFiles: [file],
              idpEntityId: 'https://idp/meta',
            }),
          );
          expect(means).toEqual(
            expect.objectContaining({
              authType: 'saml',
              grantType: flow === 'pure' ? 'saml2_pure' : 'saml2_bearer',
              samlIdpCertificates: [PEM_A, PEM_B],
              samlIdpEntityId: 'https://idp/meta',
              samlIdpSsoUrl: 'https://idp.example/sso',
              samlSpEntityId: 'sp-entity',
            }),
          );
        });

        it.each([
          [{}, ['idpCertificates', 'idpEntityId']],
          [{ idpEntityId: 'https://idp/meta' }, ['idpCertificates']],
          [{ idpCertificates: [PEM_A] }, ['idpEntityId']],
        ])(
          'without trust (%p), refuses naming %p before anything is written',
          (trust, missing) => {
            let caught: unknown;
            try {
              samlMeansOf(samlOptions(flow, trust));
            } catch (error) {
              caught = error;
            }
            expect(caught).toBeInstanceOf(SamlTrustMissingError);
            expect((caught as SamlTrustMissingError).missingFields).toEqual(
              missing,
            );
          },
        );

        it('invents no request settings: absent stays absent', () => {
          const means = samlMeansOf(samlOptions(flow, FILE_TRUST));
          expect(means.samlIdpInitiated).toBeUndefined();
        });

        it('refuses --authn-request-id: a destination cannot state it', () => {
          expect(() =>
            samlMeansOf(
              samlOptions(flow, { ...FILE_TRUST, authnRequestId: '_req1' }),
            ),
          ).toThrow('process.exit(1)');
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('--authn-request-id'),
          );
        });

        it('with --idp-initiated, the strategy never asks for an authorization URL', async () => {
          const options = samlOptions(flow, {
            ...FILE_TRUST,
            idpInitiated: true,
            acsUrl: 'https://uaa.example/saml/SSO/alias/x',
          });
          expect(samlMeansOf(options).samlIdpInitiated).toBe(true);
          const strategy = samlStrategyOf(options);
          expect(samlCallbackStrategy).not.toHaveBeenCalled();
          expect(manualSamlResponseStrategy).not.toHaveBeenCalled();

          const buildAuthorizationUrl = jest.fn();
          const outcome = await strategy.authorize({ buildAuthorizationUrl });
          expect(buildAuthorizationUrl).not.toHaveBeenCalled();
          expect(outcome).toEqual({
            payload: 'PASTED-SAML-RESPONSE',
            redirectUri: 'https://uaa.example/saml/SSO/alias/x',
          });
        });

        it.each([
          ['--idp-initiated', { idpInitiated: true }],
          ['--assertion-flow manual', { assertionFlow: 'manual' as const }],
          [
            '--idp-initiated --assertion-flow manual',
            { idpInitiated: true, assertionFlow: 'manual' as const },
          ],
        ])(
          'with %s and no ACS: refused naming --acs-url, no localhost guess',
          (_case, overrides) => {
            let thrown: unknown;
            try {
              samlStrategyOf(
                samlOptions(flow, { ...FILE_TRUST, ...overrides }),
              );
            } catch (error) {
              thrown = error;
            }
            expect(isUsageError(thrown)).toBe(true);
            expect(failureLines(thrown).join('\n')).toContain('--acs-url');
            expect(exitSpy).not.toHaveBeenCalled();
            expect(manualSamlResponseStrategy).not.toHaveBeenCalled();
          },
        );

        it("with --idp-initiated, the paste stops at the request's signal", async () => {
          const strategy = samlStrategyOf(
            samlOptions(flow, {
              ...FILE_TRUST,
              idpInitiated: true,
              acsUrl: 'https://uaa.example/saml/SSO/alias/x',
            }),
          );
          pastedInput.value = undefined;
          const controller = new AbortController();
          const pasting = strategy.authorize({
            buildAuthorizationUrl: jest.fn(),
            signal: controller.signal,
          });
          const rejected = expect(pasting).rejects.toThrow('input abandoned');
          controller.abort();
          await rejected;
          expect(interfaces.at(-1)?.closed).toBe(true);
          pastedInput.value = 'PASTED-SAML-RESPONSE';
        });

        it('with --idp-initiated and --assertion, uses the static strategy', () => {
          samlStrategyOf(
            samlOptions(flow, {
              ...FILE_TRUST,
              idpInitiated: true,
              assertion: 'ASSERTION',
            }),
          );
          expect(staticCodeStrategy).toHaveBeenCalledWith(
            expect.objectContaining({ payload: 'ASSERTION' }),
          );
        });

        it('refuses --idp-initiated with --assertion-flow browser', () => {
          expect(() =>
            samlStrategyOf(
              samlOptions(flow, {
                ...FILE_TRUST,
                idpInitiated: true,
                assertionFlow: 'browser',
              }),
            ),
          ).toThrow('process.exit(1)');
          expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('--idp-initiated'),
          );
          expect(samlCallbackStrategy).not.toHaveBeenCalled();
        });
      },
    );
  });
});

describe('a UAA URL ending in a long run of slashes', () => {
  it('the OIDC token endpoint is composed without them', () => {
    const means = buildDestinationMeans({
      authType: 'xsuaa',
      format: 'env',
      protocol: 'oidc',
      flow: 'device',
      clientId: 'c',
      uaaUrl: `https://uaa.example${'/'.repeat(100_000)}`,
    });
    expect(means.oidcTokenEndpoint).toBe('https://uaa.example/oauth/token');
  });
});

describe('readManualInput', () => {
  afterEach(() => {
    pastedInput.value = 'PASTED-SAML-RESPONSE';
  });

  it('answers what was typed, trimmed', async () => {
    await expect(readManualInput('Paste: ')).resolves.toBe(
      'PASTED-SAML-RESPONSE',
    );
  });

  // A closed stdin never answers. The promise used to stay pending, the event
  // loop drained, and the CLI exited 0 having written nothing.
  it('refuses when stdin closes without an answer', async () => {
    pastedInput.value = null;
    await expect(readManualInput('Paste: ')).rejects.toThrow(
      'no input: stdin closed at "Paste:"',
    );
  });

  // A manual strategy's deadline or dispose() aborts the read. A readline
  // left open holds stdin, and the process never exits.
  it('rejects when the signal aborts, and closes its readline', async () => {
    pastedInput.value = undefined;
    const before = interfaces.length;
    const controller = new AbortController();
    const reading = readManualInput('Paste: ', controller.signal);
    const rejected = expect(reading).rejects.toThrow(
      'input abandoned at "Paste:"',
    );
    // The question is asked one turn later, after the URL prompt.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(interfaces.length).toBe(before + 1);
    controller.abort();
    await rejected;
    expect(interfaces.at(-1)?.closed).toBe(true);
  });

  it('a signal aborted before the question is asked opens no readline', async () => {
    const before = interfaces.length;
    const controller = new AbortController();
    const reading = readManualInput('Paste: ', controller.signal);
    const rejected = expect(reading).rejects.toThrow(
      'input abandoned at "Paste:"',
    );
    controller.abort();
    await rejected;
    expect(interfaces.length).toBe(before);
  });

  it('opens no readline for a signal already aborted', async () => {
    const before = interfaces.length;
    const controller = new AbortController();
    controller.abort();
    await expect(readManualInput('Paste: ', controller.signal)).rejects.toThrow(
      'input abandoned at "Paste:"',
    );
    expect(interfaces.length).toBe(before);
  });

  it('closes its readline after an answer', async () => {
    await readManualInput('Paste: ', new AbortController().signal);
    expect(interfaces.at(-1)?.closed).toBe(true);
  });
});
