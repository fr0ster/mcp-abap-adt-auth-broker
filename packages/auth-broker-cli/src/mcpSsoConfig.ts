/**
 * Pure config-building logic for `mcp-auth oidc | saml2-pure | saml2-bearer`
 * (2.x's `mcp-sso`; the module keeps its name), importable by tests: the
 * destination a run states (its means, written to the key store), the
 * collaborators it hands the broker, and merging the parsed options with an
 * optional `--config` file. The command line itself is `subcommandArgs.ts`'s.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import type { AuthBrokerConfig } from '@mcp-abap-adt/auth-broker';
import {
  asOidcResult,
  consoleDeviceCodePresenter,
  defaultReplayStore,
  manualPasscodeStrategy,
  manualSamlResponseStrategy,
  type OidcCallbackResult,
  oidcCallbackStrategy,
  type SsoProviderConfig,
  samlCallbackStrategy,
  staticCodeStrategy,
} from '@mcp-abap-adt/auth-providers';
import type { DestinationMeans } from '@mcp-abap-adt/auth-stores';
import type {
  AuthorizationRequest,
  IAuthorizationStrategy,
  IBrowser,
} from '@mcp-abap-adt/interfaces-auth';
import {
  BROWSER_NAMES,
  type BrowserFactories,
  BrowserUsageError,
  browserFor,
  browserProgramFor,
  isBrowserName,
  SHIPPED_BROWSERS,
} from './browser';
import { asContract } from './contractShape';
import type { StatedMeans } from './destination';
import { UsageError } from './subcommandArgs';
import { withoutTrailingSlashes } from './urlText';

/**
 * The identity provider to trust is missing: the fields, by name — refused
 * before anything is written.
 */
export class SamlTrustMissingError extends UsageError {
  readonly missingFields: string[];

  constructor(message: string, missingFields: string[]) {
    super(message);
    this.name = 'SamlTrustMissingError';
    this.missingFields = [...missingFields];
  }
}

export interface McpSsoOptions {
  /** `--verbose`: the CLI's logger from `debug`. */
  verbose?: true | undefined;
  /** `--auth-debug`: the broker's `authDebug: true`; implies `--verbose`. */
  authDebug?: true | undefined;
  outputFile?: string | undefined;
  envFilePath?: string | undefined;
  destination?: string | undefined;
  serviceKeyPath?: string | undefined;
  authType: 'abap' | 'xsuaa';
  format: 'json' | 'env';
  protocol?: 'oidc' | 'saml2' | undefined;
  flow?:
    | 'browser'
    | 'device'
    | 'password'
    | 'token_exchange'
    | 'bearer'
    | 'pure'
    | undefined;
  configPath?: string | undefined;
  serviceUrl?: string | undefined;
  /** `--browser`, or a `--config` file's `browser`: one of `BROWSER_NAMES`. */
  browser?: string | undefined;
  /** `--browser-program`: the platform's named-browser factory, the program as given. */
  browserProgram?: string | undefined;
  /** Set by `applyFileConfig` when `browser` came from the `--config` file. */
  browserFromConfig?: boolean | undefined;
  // Overrides the strategy's own callback port (auth-providers'
  // DEFAULT_CALLBACK_PORT) when set; otherwise the strategy decides.
  redirectPort?: number | undefined;
  redirectUri?: string | undefined;
  issuerUrl?: string | undefined;
  authorizationEndpoint?: string | undefined;
  tokenEndpoint?: string | undefined;
  deviceAuthorizationEndpoint?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  scopes?: string[] | undefined;
  scope?: string | undefined;
  code?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  passcode?: string | undefined;
  subjectToken?: string | undefined;
  subjectTokenType?: string | undefined;
  audience?: string | undefined;
  actorToken?: string | undefined;
  actorTokenType?: string | undefined;
  idpSsoUrl?: string | undefined;
  spEntityId?: string | undefined;
  acsUrl?: string | undefined;
  relayState?: string | undefined;
  assertionFlow?: 'browser' | 'manual' | 'assertion' | undefined;
  assertion?: string | undefined;
  cookie?: string | undefined;
  uaaUrl?: string | undefined;
  samlMetadataPath?: string | undefined;
  /**
   * The identity provider's signing certificates, inline (PEM or bare base64
   * DER). Only a `--config` file carries these; `--idp-cert` names files
   * instead (`idpCertificateFiles`).
   */
  idpCertificates?: string[] | undefined;
  /** Paths from `--idp-cert`, repeatable; read by `resolveIdpCertificates`. */
  idpCertificateFiles?: string[] | undefined;
  /** The `Issuer` the assertion must name: the identity provider's entityID. */
  idpEntityId?: string | undefined;
  /**
   * The identity provider's SAML metadata, an https URL or a file: fills the
   * entityID, signing certificates and SSO URL that were not given explicitly.
   */
  idpMetadata?: string | undefined;
  /**
   * The identity provider starts the login; no AuthnRequest is sent, so the
   * assertion must carry no `InResponseTo`.
   */
  idpInitiated?: boolean | undefined;
  /** The AuthnRequest ID an `--assertion` answers, when this CLI did not send it. */
  authnRequestId?: string | undefined;
}

/**
 * Reads one line from this CLI's stdin, the question on stderr. `signal` is
 * the login's: when it aborts, the read is abandoned and its `readline`
 * closed — an open one holds stdin and keeps the process alive.
 */
export async function readManualInput(
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const abandoned = () =>
    new UsageError(
      `input abandoned at "${prompt.trim()}": the read was aborted`,
    );
  if (signal?.aborted) {
    throw abandoned();
  }
  // auth-providers' terminal compositions arm their paste — this read —
  // before they present the URL, in the same turn. Asked one turn later, the
  // question follows the URL prompt on a line of its own instead of having
  // the URL's lead appended to it. A deferral, not a bound: nothing waits on
  // a clock.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (signal?.aborted) {
    throw abandoned();
  }
  const rl = createInterface({
    input: process.stdin,
    // The prompt on stderr: stdout carries only help and --version (D16).
    output: process.stderr,
  });
  // A closed stdin never answers the question, and a promise that never
  // settles lets the event loop drain: the process exited 0 with nothing
  // written, which a script reads as success. End of input is a refusal.
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(abandoned());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.on('close', () => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      reject(new UsageError(`no input: stdin closed at "${prompt.trim()}"`));
    });
    rl.question(prompt, (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * A `--config` file's provider config: its `provider` object, or the file's
 * own `protocol`, `flow` and fields (under `config`, else the rest of the
 * file). A missing `protocol` or `flow` is kept missing — `applyFileConfig`
 * refuses a file that does not name the run's subcommand, naming what it
 * lacks. `null` only for a file that is not a JSON object.
 */
export function normalizeProviderConfig(
  input: unknown,
): SsoProviderConfig | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  // A parsed JSON file: read as a record, its shape checked field by field.
  const raw = input as Record<string, unknown>;
  if (raw.provider && typeof raw.provider === 'object') {
    return raw.provider as SsoProviderConfig;
  }
  const { protocol, flow, config, ...rest } = raw;
  return {
    protocol,
    flow,
    config: config ?? rest,
  } as SsoProviderConfig;
}

/**
 * Pre-2.0.0 provider config fields that named a JavaScript function
 * (`() => Promise<string>` or similar) rather than a value. JSON cannot
 * carry a function, so a `--config` file can never legitimately supply one —
 * if a key like this shows up, the file is stale in a way no conversion can
 * fix. Refuse rather than silently drop it, and say what to write instead.
 */
const UNSUPPORTED_LEGACY_CONFIG_FIELDS: Record<string, string> = {
  authorizationCodeProvider:
    "'authorizationCodeProvider' (a function) cannot be expressed in a --config file. Use --code for a value you already hold, or drive the OIDC browser flow interactively without it.",
  assertionProvider:
    "'assertionProvider' (a function) cannot be expressed in a --config file. Use --assertion for a value you already hold, or --assertion-flow to choose how it is obtained.",
  manualInput:
    "'manualInput' (a function) cannot be expressed in a --config file. Use --assertion-flow manual to prompt on this CLI's own stdin instead.",
};

/**
 * `--config` file fields that map 1:1 onto a `McpSsoOptions` field of the
 * same name — every pre-2.0.0 config field the strategies still need, other
 * than `authorizationCode` (see `applyFileConfig`), lands here.
 */
const CONFIG_BACKFILL_FIELDS: (keyof McpSsoOptions)[] = [
  'browser',
  'redirectPort',
  'redirectUri',
  'issuerUrl',
  'authorizationEndpoint',
  'tokenEndpoint',
  'deviceAuthorizationEndpoint',
  'clientId',
  'clientSecret',
  'scopes',
  'scope',
  'username',
  'password',
  'passcode',
  'subjectToken',
  'subjectTokenType',
  'audience',
  'actorToken',
  'actorTokenType',
  'idpSsoUrl',
  'spEntityId',
  'acsUrl',
  'relayState',
  'assertionFlow',
  'assertion',
  'cookie',
  'uaaUrl',
  'idpEntityId',
  'idpMetadata',
  'authnRequestId',
];

/**
 * Backfills `options` in place from a `--config` file's raw `config` object.
 * CLI flags always win — a field already set on `options` is left alone; the
 * file only fills gaps.
 *
 * This is what makes a config-file run (no --flow, or no flag at all, on the
 * CLI) reach the same strategy-building code as a CLI-flag run: without it,
 * the file's fields — including a `browser`/`redirectPort` a 2.0.0 provider
 * no longer accepts directly — would reach `SsoProviderFactory.create()`
 * untouched and be silently ignored.
 *
 * Every field a pre-2.0.0 config could carry either lands on its
 * `McpSsoOptions` equivalent here (which the strategy built from `options`
 * then consumes) or the run is refused via `process.exit(1)` naming what to
 * write instead. Nothing may reach the provider without one of those two
 * happening.
 *
 * Also backfills `options.flow` from the file when the command line didn't
 * set it — `mcp-auth oidc --config f` must still resolve to a real flow, or
 * nothing downstream ever calls a builder at all. A file naming another
 * subcommand than the run's is refused naming `--config` (D24).
 *
 * A no-op when `fileConfig` is `null` (no `--config` was given), so callers
 * can invoke this unconditionally.
 */
/** The `mcp-auth` subcommand a run's protocol and flow are. */
function subcommandOf(options: Pick<McpSsoOptions, 'protocol' | 'flow'>) {
  if (options.protocol === 'oidc') return 'oidc';
  return options.flow === 'bearer' ? 'saml2-bearer' : 'saml2-pure';
}

export function applyFileConfig(
  options: McpSsoOptions,
  fileConfig: SsoProviderConfig | null,
): void {
  if (!fileConfig) {
    return;
  }

  // The file belongs to the subcommand its protocol and flow name (D24): a
  // run's protocol — and a SAML run's flow — is the subcommand's. A file
  // that names no protocol, a SAML file that names no flow, and a file naming
  // another subcommand are refused, never merged. An OIDC file names `oidc`
  // by its protocol; its flow fills a flow the command line left out, as 2.x.
  if (options.protocol !== undefined) {
    const own = subcommandOf(options);
    const refuse = (why: string) => {
      console.error(
        `❌ --config: the file ${why}; mcp-auth ${own} takes a file whose protocol and flow name it (oidc, saml2-pure, saml2-bearer).`,
      );
      process.exit(1);
    };
    if (fileConfig.protocol === undefined || fileConfig.protocol === null) {
      refuse('states no protocol');
    } else if (options.protocol === 'saml2' && !fileConfig.flow) {
      refuse('states no flow');
    } else if (
      fileConfig.protocol !== options.protocol ||
      (options.protocol === 'saml2' && fileConfig.flow !== options.flow)
    ) {
      refuse(`names another subcommand than mcp-auth ${own}`);
    }
  }
  options.protocol = options.protocol ?? fileConfig.protocol;
  options.flow = options.flow ?? (fileConfig.flow as McpSsoOptions['flow']);

  const fields = ((fileConfig as { config?: unknown }).config ?? {}) as Record<
    string,
    unknown
  >;

  for (const [field, guidance] of Object.entries(
    UNSUPPORTED_LEGACY_CONFIG_FIELDS,
  )) {
    if (fields[field] !== undefined) {
      console.error(`❌ --config: ${guidance}`);
      process.exit(1);
    }
  }

  // Pre-2.0.0 field name for the OIDC manual/OOB code paste path; maps onto
  // the same slot --code fills.
  if (
    options.code === undefined &&
    typeof fields.authorizationCode === 'string'
  ) {
    options.code = fields.authorizationCode;
  }

  for (const field of CONFIG_BACKFILL_FIELDS) {
    if (options[field] === undefined && fields[field] !== undefined) {
      // Kept: the file's value is copied as the file states it, unchecked, as
      // since 2.0.0; typing it per field would mean validating it — a change
      // of behaviour, not of types.
      (options as unknown as Record<string, unknown>)[field] = fields[field];
      if (field === 'browser') options.browserFromConfig = true;
    }
  }

  if (fields.idpInitiated !== undefined) {
    // A string "false" would be truthy and silently declare the opposite.
    if (typeof fields.idpInitiated !== 'boolean') {
      console.error("❌ --config: 'idpInitiated' must be true or false.");
      process.exit(1);
    }
    options.idpInitiated = options.idpInitiated ?? fields.idpInitiated;
  }

  if (fields.idpCertificates !== undefined) {
    const raw = fields.idpCertificates;
    const list = typeof raw === 'string' ? [raw] : raw;
    if (
      !Array.isArray(list) ||
      !list.every((entry) => typeof entry === 'string')
    ) {
      console.error(
        "❌ --config: 'idpCertificates' must be a string or a list of strings (PEM or base64 DER).",
      );
      process.exit(1);
    }
    // Trust is replaced, never widened: a certificate named on the CLI means
    // the file's list is not trusted alongside it. A rotated-out certificate
    // left in the file must not keep verifying assertions.
    if (
      options.idpCertificates === undefined &&
      options.idpCertificateFiles === undefined
    ) {
      options.idpCertificates = list as string[];
    }
  }
}

const PEM_CERTIFICATE_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Reads one `--idp-cert` file into the entries `idpCertificates` takes. A
 * PEM file may hold several certificates (a rotation bundle); each becomes
 * its own entry, since a single string is read as one certificate and the
 * rest would be ignored. A binary DER file (`.cer`, `.der`) is base64-encoded.
 * Whether the result is a certificate at all is the provider's check.
 */
export function readIdpCertificateFile(filePath: string): string[] {
  const resolved = resolvePath(filePath);
  let content: Buffer;
  try {
    content = readFileSync(resolved);
  } catch {
    console.error(`❌ IdP certificate file not found: ${resolved}`);
    process.exit(1);
  }
  const text = content.toString('utf8');
  const blocks = text.match(PEM_CERTIFICATE_BLOCK);
  if (blocks) {
    return blocks;
  }
  if (
    text.includes('-----BEGIN') ||
    BASE64_TEXT.test(text.replace(/\s+/g, ''))
  ) {
    return [text.trim()];
  }
  return [content.toString('base64')];
}

/**
 * The certificates the SAML providers are given: inline ones (a `--config`
 * file) and those read from `--idp-cert` files. `undefined` when there are
 * none, so `buildSamlTrust` names what is missing.
 */
export function resolveIdpCertificates(
  options: McpSsoOptions,
): string[] | undefined {
  const certificates = [
    ...(options.idpCertificates ?? []),
    ...(options.idpCertificateFiles ?? []).flatMap(readIdpCertificateFile),
  ];
  return certificates.length > 0 ? certificates : undefined;
}

/**
 * Parses the SAML trust flags into `target`, returning how many values after
 * `arg` were consumed (0 for a flag with no value, or an argument that is not
 * one of these).
 */
export function parseSamlTrustArg(
  target: Partial<McpSsoOptions>,
  arg: string,
  next: string | undefined,
): number {
  switch (arg) {
    case '--idp-cert':
      if (!next || next.startsWith('--')) {
        console.error('❌ --idp-cert needs a certificate file path.');
        process.exit(1);
      }
      // Repeatable: every occurrence adds a certificate, for key rotation.
      target.idpCertificateFiles = [
        ...(target.idpCertificateFiles ?? []),
        next,
      ];
      return 1;
    case '--idp-entity-id':
      target.idpEntityId = next;
      return 1;
    case '--idp-metadata':
      if (!next || next.startsWith('--')) {
        console.error('❌ --idp-metadata needs an https URL or a file path.');
        process.exit(1);
      }
      target.idpMetadata = next;
      return 1;
    case '--idp-initiated':
      // A flag with no value. Left undefined when absent, so a --config
      // file's idpInitiated can still fill it.
      target.idpInitiated = true;
      return 0;
    case '--authn-request-id':
      target.authnRequestId = next;
      return 1;
    default:
      return 0;
  }
}

function requireOption(value: string | undefined, flagName: string): string {
  if (!value) {
    console.error(`❌ ${flagName} is required for this flow.`);
    process.exit(1);
  }
  return value;
}

function resolveOidcTokenEndpoint(options: McpSsoOptions): string | undefined {
  return (
    options.tokenEndpoint ||
    (options.uaaUrl
      ? `${withoutTrailingSlashes(options.uaaUrl)}/oauth/token`
      : undefined)
  );
}

/** A grant a destination states (`@mcp-abap-adt/interfaces-auth-broker`). */
export type DestinationGrant = NonNullable<DestinationMeans['grantType']>;

/** The row a run is: what the destination states (`authType` / `grantType`). */
export interface SsoRow {
  authType: 'jwt' | 'saml';
  grantType: DestinationGrant;
}

/**
 * `--flow password` is the password grant when a password is given. With
 * `--passcode` — or with neither a password nor a user, when the passcode is
 * asked for — it is the UAA `passcode` grant: a one-time code cannot log in
 * twice, so a destination that stored it as a password could never renew.
 */
function isPasscodeRun(options: McpSsoOptions): boolean {
  return (
    !!options.passcode ||
    (options.password === undefined && options.username === undefined)
  );
}

/**
 * The destination a run states: `authType` and `grantType` from the
 * protocol and flow — never from which fields happen to be present, beyond the
 * two flags that name a different way in (`--passcode`, `--cookie`).
 */
export function ssoRow(options: McpSsoOptions): SsoRow {
  if (options.protocol === 'oidc') {
    switch (options.flow) {
      case 'browser':
        return { authType: 'jwt', grantType: 'oidc_authorization_code' };
      case 'device':
        return { authType: 'jwt', grantType: 'device_code' };
      case 'password':
        return {
          authType: 'jwt',
          grantType: isPasscodeRun(options) ? 'passcode' : 'password',
        };
      case 'token_exchange':
        return { authType: 'jwt', grantType: 'token_exchange' };
      default:
        throw new UsageError(`Unsupported OIDC flow: ${options.flow}`);
    }
  }
  if (options.protocol === 'saml2') {
    switch (options.flow) {
      case 'bearer':
        return { authType: 'saml', grantType: 'saml2_bearer' };
      case 'pure':
        // The user hands the cookies over: nothing obtains them, so the
        // destination presents what it holds.
        return {
          authType: 'saml',
          grantType: options.cookie ? 'none' : 'saml2_pure',
        };
      default:
        throw new UsageError(`Unsupported SAML flow: ${options.flow}`);
    }
  }
  throw new UsageError(
    options.protocol
      ? `Unsupported protocol: ${options.protocol}`
      : 'Provider config is missing: run mcp-auth oidc, saml2-pure or saml2-bearer.',
  );
}

/** Scopes as the store keeps them: one per entry, none with whitespace. */
function scopeList(scopes: unknown): string[] | undefined {
  const list = Array.isArray(scopes)
    ? scopes
    : typeof scopes === 'string'
      ? [scopes]
      : [];
  const split = list
    .flatMap((entry) => String(entry).split(/[,\s]+/))
    .filter(Boolean);
  return split.length > 0 ? split : undefined;
}

/** The client of an OIDC row: an id, a secret (`''` a public client), a UAA URL when given. */
function oidcClient(options: McpSsoOptions): StatedMeans {
  return {
    uaaUrl: options.uaaUrl ?? null,
    uaaClientId: requireOption(options.clientId, '--client-id'),
    uaaClientSecret: options.clientSecret ?? '',
  };
}

/**
 * The SAML trust a destination states: the identity provider's signing
 * certificates and its entityID. The broker builds the assertion validator its
 * grant requires from them (`createSignedResponseValidator` for pure,
 * `createSignedAssertionValidator` for bearer). Missing trust is refused here,
 * naming each field, before anything is written.
 */
function buildSamlTrust(options: McpSsoOptions): StatedMeans {
  const idpCertificates = resolveIdpCertificates(options);
  const missing: string[] = [];
  if (!idpCertificates) missing.push('idpCertificates');
  if (!options.idpEntityId) missing.push('idpEntityId');
  if (missing.length > 0) {
    throw new SamlTrustMissingError(
      `The assertion validator needs the identity provider to trust: missing ${missing.join(', ')}. ` +
        'Supply --idp-cert and --idp-entity-id, or --idp-metadata.',
      missing,
    );
  }
  if (options.authnRequestId) {
    // A destination has no field for it, and the broker builds the SAML
    // provider from the destination alone.
    console.error(
      '❌ --authn-request-id cannot be stated in a destination: the broker builds the SAML provider ' +
        'out of the destination alone, which holds no request ID. Use --idp-initiated, or let mcp-auth send the request ' +
        '(--assertion-flow browser or manual).',
    );
    process.exit(1);
  }
  return {
    samlIdpCertificates: idpCertificates,
    samlIdpEntityId: options.idpEntityId,
  };
}

function samlCommon(options: McpSsoOptions): StatedMeans {
  return {
    samlIdpSsoUrl: requireOption(options.idpSsoUrl, '--idp-sso-url'),
    samlSpEntityId: requireOption(options.spEntityId, '--sp-entity-id'),
    samlAcsUrl: options.acsUrl,
    samlRelayState: options.relayState,
    samlIdpInitiated: options.idpInitiated === true ? true : undefined,
    ...buildSamlTrust(options),
  };
}

/**
 * The means a run writes to the key store (one row per command and flow): `authType`,
 * `grantType`, the grant's data and the client, and `serviceUrl` when given.
 * The means secrets the user gave — a password, a subject or actor token, a
 * client secret — are written here because the user asked for a destination
 * that can renew; the broker never writes them. A public client is a secret of
 * `''`. Nothing obtained by a login is means: the passcode, the code, the
 * assertion and the cookies are not written here.
 */
export function buildDestinationMeans(options: McpSsoOptions): StatedMeans {
  const row = ssoRow(options);
  const base: StatedMeans = {
    authType: row.authType,
    grantType: row.grantType,
    serviceUrl: options.serviceUrl,
  };
  switch (row.grantType) {
    case 'oidc_authorization_code':
      return {
        ...base,
        ...oidcClient(options),
        oidcIssuerUrl: options.issuerUrl,
        oidcAuthorizationEndpoint: options.authorizationEndpoint,
        oidcTokenEndpoint: resolveOidcTokenEndpoint(options),
        oidcScopes: scopeList(options.scopes),
      };
    case 'device_code':
      return {
        ...base,
        ...oidcClient(options),
        oidcIssuerUrl: options.issuerUrl,
        oidcDeviceAuthorizationEndpoint: options.deviceAuthorizationEndpoint,
        oidcTokenEndpoint: resolveOidcTokenEndpoint(options),
        oidcScopes: scopeList(options.scopes),
      };
    case 'password':
      return {
        ...base,
        ...oidcClient(options),
        oidcIssuerUrl: options.issuerUrl,
        oidcTokenEndpoint: resolveOidcTokenEndpoint(options),
        oidcScopes: scopeList(options.scopes),
        username: requireOption(options.username, '--username'),
        password: requireOption(options.password, '--password'),
      };
    case 'passcode':
      // The UAA passcode grant: `<uaaUrl>/oauth/token`, the client alone.
      return {
        ...base,
        uaaUrl: requireOption(options.uaaUrl, '--uaa-url (or --service-key)'),
        uaaClientId: requireOption(options.clientId, '--client-id'),
        uaaClientSecret: options.clientSecret ?? '',
      };
    case 'token_exchange':
      return {
        ...base,
        ...oidcClient(options),
        oidcIssuerUrl: options.issuerUrl,
        oidcTokenEndpoint: resolveOidcTokenEndpoint(options),
        oidcScopes: scopeList(options.scope ?? options.scopes),
        oidcSubjectToken: requireOption(
          options.subjectToken,
          '--subject-token',
        ),
        oidcSubjectTokenType:
          options.subjectTokenType ||
          'urn:ietf:params:oauth:token-type:access_token',
        oidcAudience: options.audience,
        oidcActorToken: options.actorToken,
        oidcActorTokenType: options.actorTokenType,
      };
    case 'saml2_bearer':
      return {
        ...base,
        ...samlCommon(options),
        samlTokenUrl: options.tokenEndpoint,
        uaaUrl: requireOption(options.uaaUrl, '--uaa-url (or --service-key)'),
        uaaClientId: requireOption(options.clientId, '--client-id'),
        uaaClientSecret: options.clientSecret ?? '',
      };
    case 'saml2_pure':
      return { ...base, ...samlCommon(options) };
    case 'none':
      // The cookies the user handed over are the secret; the destination
      // states only where they are presented.
      return base;
    default:
      throw new UsageError(`unreachable grant ${row.grantType}`);
  }
}

/**
 * The browser a run states — `--browser` or a `--config` file's `browser`,
 * mapped by the same table (`browserFor`), or `--browser-program` — on this
 * platform; nothing stated is `auto`, the default of every flow that opens a
 * browser (D15); `undefined` for `none` / `headless`. Throws
 * `BrowserUsageError` for an unknown name (naming `browser`), for both flags
 * together, and for a launcher this platform has none of. Reads and launches
 * nothing.
 */
export function ssoBrowser(
  options: Pick<
    McpSsoOptions,
    'browser' | 'browserProgram' | 'browserFromConfig'
  >,
  platform: string = process.platform,
  factories: BrowserFactories = SHIPPED_BROWSERS,
): IBrowser | undefined {
  if (options.browserProgram !== undefined) {
    if (options.browser !== undefined) {
      // Name what the user stated: the flag, or the --config file's field.
      throw new BrowserUsageError(
        options.browserFromConfig === true
          ? "--browser-program excludes the --config file's browser"
          : '--browser-program excludes --browser',
      );
    }
    return browserProgramFor(options.browserProgram, platform, factories);
  }
  const name = options.browser ?? 'auto';
  if (!isBrowserName(name)) {
    throw new BrowserUsageError(
      `browser must be one of: ${BROWSER_NAMES.join(', ')}`,
    );
  }
  return browserFor(name, platform, factories);
}

/**
 * Whether the run's login opens a browser: the OIDC browser flow without a
 * `--code`, and a SAML login whose assertion is neither given, nor pasted, nor
 * started at the identity provider. The handed-over cookies log in nowhere.
 */
export function opensBrowser(options: McpSsoOptions): boolean {
  if (options.protocol === 'oidc') {
    return options.flow === 'browser' && !options.code;
  }
  if (options.protocol === 'saml2') {
    return (
      !options.cookie &&
      !options.assertion &&
      !options.idpInitiated &&
      (options.assertionFlow ?? 'browser') === 'browser'
    );
  }
  return false;
}

/**
 * Only the OIDC 'browser' flow opens a browser; routes `--browser`,
 * `--redirect-port` and manual/OOB code paste into the strategy that
 * replaces them.
 */
export function buildOidcBrowserAuthorization(
  options: McpSsoOptions,
): IAuthorizationStrategy<OidcCallbackResult> {
  if (options.code) {
    // The consumer already holds the code (manual paste / OOB redirect
    // URI); no callback server is opened at all.
    return asOidcResult(
      staticCodeStrategy(
        asContract<Parameters<typeof staticCodeStrategy>[0]>({
          redirectUri: options.redirectUri,
          payload: options.code,
        }),
      ),
    );
  }
  // No fallback: an omitted --redirect-port lets the strategy bind its own
  // default port rather than this CLI pinning a number it doesn't own.
  return oidcCallbackStrategy(
    asContract<Parameters<typeof oidcCallbackStrategy>[0]>({
      port: options.redirectPort,
      browser: ssoBrowser(options),
    }),
  );
}

/**
 * The UAA passcode: `--passcode` when given, else read from this terminal —
 * the strategy shows where to fetch one (`<uaa>/passcode`).
 */
export function buildPasscodeAuthorization(
  options: McpSsoOptions,
): IAuthorizationStrategy<string> {
  if (options.passcode) {
    return staticCodeStrategy({ payload: options.passcode });
  }
  return manualPasscodeStrategy({
    read: (prompt, signal) => readManualInput(prompt, signal),
  });
}

/**
 * Whether the run's SAML login is a paste — `--assertion-flow manual` (or an
 * `assertion` flow given no value), or the IdP-initiated paste: the user
 * lifts the SAMLResponse the identity provider posted to the ACS, so the ACS
 * must be declared. Handed-over cookies and an `--assertion` paste nothing;
 * an IdP-initiated browser flow is refused on its own.
 */
export function pastesSamlResponse(options: McpSsoOptions): boolean {
  if (options.protocol !== 'saml2') return false;
  if (options.cookie || options.assertion) return false;
  if (options.idpInitiated) return options.assertionFlow !== 'browser';
  return (options.assertionFlow ?? 'browser') !== 'browser';
}

/**
 * The ACS a SAML paste declares — `--acs-url`, else the SP metadata's
 * (`--saml-metadata`, `<uaa.url>/saml/metadata`), else the `--config` file's
 * `acsUrl`, each already merged into `options` — or a usage error naming
 * `--acs-url`. There is no fallback: a localhost callback is not where any
 * identity provider posts.
 */
export function declaredAcs(options: McpSsoOptions): string {
  if (options.acsUrl) return options.acsUrl;
  throw new UsageError(
    options.flow === 'bearer'
      ? '--acs-url: a pasted SAML login needs the ACS the identity provider posts to; give --acs-url, the XSUAA metadata (--saml-metadata or --service-key), or acsUrl in the --config file'
      : '--acs-url: a pasted SAML login needs the ACS the identity provider posts to; give --acs-url, or acsUrl in the --config file',
  );
}

/**
 * Both SAML flows (bearer, pure) can open a browser; routes `--browser`,
 * `--redirect-port` and the manual/static assertion options into the
 * strategy that replaces them.
 */
export function buildSamlAuthorization(
  options: McpSsoOptions,
): IAuthorizationStrategy<string> {
  if (options.assertion) {
    // The consumer already holds the assertion; nothing is opened or asked.
    return staticCodeStrategy(
      asContract<Parameters<typeof staticCodeStrategy>[0]>({
        redirectUri: options.acsUrl,
        payload: options.assertion,
      }),
    );
  }
  if (options.idpInitiated) {
    return buildIdpInitiatedAuthorization(options);
  }
  const assertionFlow = options.assertionFlow || 'browser';
  if (assertionFlow !== 'browser') {
    // 'manual', and an 'assertion' flow given no value, both need a human to
    // lift the SAMLResponse out of the POST body by hand, at the ACS the
    // identity provider posts to: declared, never a localhost guess.
    return manualSamlResponseStrategy({
      redirectUri: declaredAcs(options),
      read: (prompt, signal) => readManualInput(prompt, signal),
    });
  }
  // No fallback: an omitted --redirect-port lets the strategy bind its own
  // default port rather than this CLI pinning a number it doesn't own.
  return samlCallbackStrategy(
    asContract<Parameters<typeof samlCallbackStrategy>[0]>({
      port: options.redirectPort,
      browser: ssoBrowser(options),
    }),
  );
}

/**
 * An IdP-initiated login has no URL for this CLI to open: the only one
 * auth-providers can build carries an AuthnRequest, and with `idpInitiated`
 * it refuses to build one. So the strategy never calls
 * `buildAuthorizationUrl` — the user starts the login at the identity
 * provider and pastes the SAMLResponse it posts. The browser flow, which
 * exists to open that URL, is refused rather than left to fail after the
 * provider is built.
 */
function buildIdpInitiatedAuthorization(options: McpSsoOptions) {
  if (options.assertionFlow === 'browser') {
    console.error(
      '❌ --idp-initiated cannot use --assertion-flow browser: there is no request URL to open. ' +
        'Start the login at the identity provider and use --assertion-flow manual, or pass --assertion.',
    );
    process.exit(1);
  }
  // The ACS the assertion names as its Recipient: declared, never guessed.
  const redirectUri = declaredAcs(options);
  return {
    async authorize(request: AuthorizationRequest) {
      // The login's signal ends the paste: every waiter gone, the read is
      // abandoned and its readline closed.
      const payload = await readManualInput(
        'Start the login at your identity provider, then paste the SAMLResponse (from the POST body): ',
        request.signal,
      );
      if (!payload) {
        throw new UsageError('No SAMLResponse was provided');
      }
      return { payload, redirectUri };
    },
  };
}

/**
 * `saml2_pure`: the system's session cookies for the SAMLResponse. With
 * `--assertion-flow assertion` the response itself is presented; otherwise the
 * user pastes the cookies the system set.
 */
export function buildSamlCookieProvider(
  options: McpSsoOptions,
): (samlResponse: string) => Promise<string> {
  const assertionFlow =
    options.assertionFlow || (options.assertion ? 'assertion' : 'browser');
  return async (samlResponse: string) => {
    if (assertionFlow === 'assertion') {
      return `SAMLResponse=${samlResponse}`;
    }
    return readManualInput('Paste session cookies: ');
  };
}

/** The broker options through which a run's collaborators reach its provider. */
export type SsoCollaborators = {
  [K in
    | 'authorization'
    | 'oidcAuthorization'
    | 'deviceCodePresenter'
    | 'samlCookies'
    | 'assertionReplayStore']-?: NonNullable<AuthBrokerConfig[K]>;
};

/**
 * Every collaborator a provider the broker builds may need, stated by this CLI
 * — the broker supplies none: the interactive strategy of the passcode and
 * SAML grants, the OIDC browser strategy, the device-code presenter — given no
 * logger, so the code is always shown on stderr, whatever the log level — the
 * SAML cookie function and the process-wide replay
 * store the assertion validators share. The broker calls only the ones the
 * destination's grant uses, once, when it builds the provider.
 */
export function buildCollaborators(options: McpSsoOptions): SsoCollaborators {
  return {
    authorization: (_destination, grant) => {
      switch (grant) {
        case 'passcode':
          return buildPasscodeAuthorization(options);
        case 'saml2_pure':
        case 'saml2_bearer':
          return buildSamlAuthorization(options);
        default:
          // These subcommands state no authorization_code destination: that is auth-code's.
          throw new UsageError(
            `mcp-auth ${subcommandOf(options)} has no interactive strategy for ${grant}`,
          );
      }
    },
    oidcAuthorization: () => buildOidcBrowserAuthorization(options),
    deviceCodePresenter: () => consoleDeviceCodePresenter(),
    samlCookies: () => buildSamlCookieProvider(options),
    assertionReplayStore: () => defaultReplayStore,
  };
}
