/**
 * Coverage for the CLI/config merge in bin/mcpSsoConfig.ts.
 *
 * This is the code `mcp-sso`'s `main()` uses to reconcile `--protocol`/
 * `--flow`/flag options with an optional `--config <path.json>` file before
 * building the strategy a provider will use. Before this file existed, a
 * `--config`-only run never touched the strategy-building code at all: a
 * `browser`/`redirectPort`/`authorizationCode`/`assertionFlow` serialized in
 * the file reached `SsoProviderFactory.create()` untouched, silently
 * ignored by the 2.0.0 provider. These tests pin that a file's fields reach
 * the strategy, that a CLI flag overrides them, and that every legacy field
 * either converts or refuses — never neither.
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
const asOidcResult = jest.fn((inner: unknown) => ({
  __kind: 'asOidcResult',
  inner,
}));

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
  asOidcResult: (...args: unknown[]) => (asOidcResult as any)(...args),
}));

// The IdP-initiated strategy reads the pasted SAMLResponse through
// readManualInput; answer it here instead of waiting on a terminal.
const pastedInput: { value: string | null } = {
  value: 'PASTED-SAML-RESPONSE',
};
// Like the real interface, `close()` emits 'close'. `null` stands for a
// closed stdin: the question is never answered and the stream just ends.
jest.mock('node:readline', () => ({
  createInterface: () => {
    const onClose: Array<() => void> = [];
    return {
      on: (event: string, listener: () => void) => {
        if (event === 'close') onClose.push(listener);
      },
      question: (_prompt: string, answer: (value: string) => void) => {
        if (pastedInput.value === null) {
          for (const listener of onClose) listener();
          return;
        }
        answer(` ${pastedInput.value} `);
      },
      close: () => {
        for (const listener of onClose) listener();
      },
    };
  },
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyFileConfig,
  buildProviderConfig,
  type McpSsoOptions,
  normalizeProviderConfig,
  parseSamlTrustArg,
  readIdpCertificateFile,
  readManualInput,
} from '../../../bin/mcpSsoConfig';

function baseOptions(overrides: Partial<McpSsoOptions> = {}): McpSsoOptions {
  return {
    authType: 'xsuaa',
    format: 'env',
    ...overrides,
  };
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

      buildProviderConfig(options, null, null);

      expect(oidcCallbackStrategy).toHaveBeenCalledTimes(1);
      expect(oidcCallbackStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ port: 4001, browser: 'chrome' }),
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

      buildProviderConfig(options, null, null);

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

      expect(() => buildProviderConfig(options, null, null)).toThrow(
        'process.exit(1)',
      );
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

      expect(() => buildProviderConfig(options, null, null)).not.toThrow();
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
        browser: 'firefox',
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);
      buildProviderConfig(options, null, null);

      expect(samlCallbackStrategy).toHaveBeenCalledWith(
        expect.objectContaining({ browser: 'firefox' }),
      );
    });

    it('converts a legacy `redirectPort` field into the strategy', () => {
      const fileConfig = normalizeProviderConfig({
        protocol: 'saml2',
        flow: 'bearer',
        idpSsoUrl: 'https://idp.example/sso',
        spEntityId: 'sp-entity',
        redirectPort: 5005,
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);
      buildProviderConfig(options, null, null);

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

      buildProviderConfig(options, null, null);

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
        assertionFlow: 'manual',
      });

      const options = baseOptions();
      applyFileConfig(options, fileConfig);
      buildProviderConfig(options, null, null);

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
        idpSsoUrl: 'https://idp.example/sso',
        spEntityId: 'sp-entity',
        ...overrides,
      });
    }

    function samlConfigOf(options: McpSsoOptions): Record<string, unknown> {
      return (
        buildProviderConfig(options, null, null) as unknown as {
          config: Record<string, unknown>;
        }
      ).config;
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
      'passing into the %s config',
      (flow) => {
        it('carries inline and file certificates, entity id and request settings', () => {
          const file = writeFile('rotated.pem', PEM_B);
          const config = samlConfigOf(
            samlOptions(flow, {
              idpCertificates: [PEM_A],
              idpCertificateFiles: [file],
              idpEntityId: 'https://idp/meta',
              authnRequestId: '_req1',
            }),
          );
          expect(config).toEqual(
            expect.objectContaining({
              idpCertificates: [PEM_A, PEM_B],
              idpEntityId: 'https://idp/meta',
              authnRequestId: '_req1',
              spEntityId: 'sp-entity',
            }),
          );
        });

        it('invents no trust material: absent stays absent for the provider to name', () => {
          const config = samlConfigOf(samlOptions(flow));
          expect(config.idpCertificates).toBeUndefined();
          expect(config.idpEntityId).toBeUndefined();
          expect(config.idpInitiated).toBeUndefined();
          expect(config.authnRequestId).toBeUndefined();
        });

        it('with --idp-initiated, the strategy never asks for an authorization URL', async () => {
          const config = samlConfigOf(
            samlOptions(flow, {
              idpInitiated: true,
              acsUrl: 'https://uaa.example/saml/SSO/alias/x',
            }),
          );
          expect(config.idpInitiated).toBe(true);
          expect(samlCallbackStrategy).not.toHaveBeenCalled();
          expect(manualSamlResponseStrategy).not.toHaveBeenCalled();

          const buildAuthorizationUrl = jest.fn();
          const outcome = await (
            config.authorization as {
              authorize: (request: unknown) => Promise<unknown>;
            }
          ).authorize({ buildAuthorizationUrl });
          expect(buildAuthorizationUrl).not.toHaveBeenCalled();
          expect(outcome).toEqual({
            payload: 'PASTED-SAML-RESPONSE',
            redirectUri: 'https://uaa.example/saml/SSO/alias/x',
          });
        });

        it('with --idp-initiated and no --acs-url, names the default callback as the ACS', async () => {
          const config = samlConfigOf(
            samlOptions(flow, { idpInitiated: true }),
          );
          const outcome = await (
            config.authorization as {
              authorize: (request: unknown) => Promise<{ redirectUri: string }>;
            }
          ).authorize({ buildAuthorizationUrl: jest.fn() });
          expect(outcome.redirectUri).toBe('http://localhost:61001/callback');
        });

        it('with --idp-initiated and --assertion, uses the static strategy', () => {
          samlConfigOf(
            samlOptions(flow, { idpInitiated: true, assertion: 'ASSERTION' }),
          );
          expect(staticCodeStrategy).toHaveBeenCalledWith(
            expect.objectContaining({ payload: 'ASSERTION' }),
          );
        });

        it('refuses --idp-initiated with --assertion-flow browser', () => {
          expect(() =>
            samlConfigOf(
              samlOptions(flow, {
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
});
