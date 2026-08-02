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

import {
  applyFileConfig,
  buildProviderConfig,
  type McpSsoOptions,
  normalizeProviderConfig,
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
});
