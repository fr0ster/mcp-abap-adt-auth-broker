/**
 * `mcp-auth`'s command line, read from an argument array it is handed —
 * never from the process's own arguments — so every form is testable and the bin is a thin shell.
 *
 * One command (§10, D24): `mcp-auth [auth-code]` is the UAA authorization code
 * login (or `--credential` client credentials); `oidc`, `saml2-pure` and
 * `saml2-bearer` are what 2.x's `mcp-sso` did, with the same flags. The
 * subcommand is the protocol and flow, so `--protocol` is refused; `--dev` is
 * gone, refused as an unknown option like any other. A `--config` file's
 * protocol and flow are checked against the subcommand where the file is read
 * (`applyFileConfig`).
 *
 * The parser reads each argument as a whole string, compared with `===`: no
 * regular expression runs over what the user typed. A usage error is a
 * `UsageError` in fixed words; it names the flag, never a value the user gave.
 */

import type { McpSsoOptions } from './mcpSsoConfig';
import type { McpAuthOptions } from './runMcpAuth';

/** The subcommands, in the order help lists them. */
export const SUBCOMMANDS = [
  'auth-code',
  'oidc',
  'saml2-pure',
  'saml2-bearer',
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

/** The subcommands that were 2.x's `mcp-sso`. */
export type SsoSubcommand = Exclude<Subcommand, 'auth-code'>;

/** What a command line asks for. */
export type ParsedCommand =
  | { kind: 'help'; subcommand?: Subcommand }
  | { kind: 'version' }
  | { kind: 'auth-code'; options: McpAuthOptions }
  | { kind: 'sso'; subcommand: SsoSubcommand; options: McpSsoOptions };

/** The brand of `UsageError`: module-private, so only this module sets it. */
const USAGE_ERROR = Symbol('mcp-auth usage error');

/** A command line this CLI does not accept, in fixed words. */
export class UsageError extends Error {
  readonly [USAGE_ERROR] = true;

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Whether a caught value is this CLI's own usage error — by its brand. */
export function isUsageError(value: unknown): value is UsageError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [USAGE_ERROR]?: unknown })[USAGE_ERROR] === true
  );
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * The whole command line: `help` / `version` as commands, a subcommand first,
 * else `auth-code`'s options. No arguments at all is help, as 2.x.
 */
export function parseCommandLine(args: readonly string[]): ParsedCommand {
  const first = args[0];
  if (first === undefined || first === 'help') return { kind: 'help' };
  if (first === 'version') return { kind: 'version' };
  if (first.startsWith('-')) return parseSubcommandArgs('auth-code', args);
  if (!isSubcommand(first)) {
    throw new UsageError(
      `unknown command; the commands are ${SUBCOMMANDS.join(', ')}`,
    );
  }
  return parseSubcommandArgs(first, args.slice(1));
}

/**
 * One subcommand's arguments (the subcommand itself not among them): help,
 * version, or its options. Throws `UsageError` for an argument it does not
 * take.
 */
export function parseSubcommandArgs(
  subcommand: Subcommand,
  args: readonly string[],
): ParsedCommand {
  if (
    args.length === 0 ||
    args[0] === 'help' ||
    args.includes('--help') ||
    args.includes('-h')
  ) {
    return { kind: 'help', subcommand };
  }
  if (
    args[0] === 'version' ||
    args.includes('--version') ||
    args.includes('-v')
  ) {
    return { kind: 'version' };
  }
  if (subcommand === 'auth-code') {
    return { kind: 'auth-code', options: parseAuthCodeArgs(args) };
  }
  return { kind: 'sso', subcommand, options: parseSsoArgs(subcommand, args) };
}

/** An argument no flag takes: named when it is a flag, never when a value. */
function unknownArgument(arg: string, position: number): UsageError {
  return new UsageError(
    arg.startsWith('-')
      ? `unknown option: ${arg}`
      : `unexpected argument at position ${position + 1}`,
  );
}

/** The flags of `mcp-auth [auth-code]` that take a value. */
const AUTH_CODE_VALUE_FLAGS: readonly string[] = [
  '--service-key',
  '--env',
  '--output',
  '--type',
  '--browser',
  '--browser-program',
  '--format',
  '--service-url',
  '--redirect-port',
  '--client-auth',
  '--basic-encoding',
  '--cert-path',
  '--key-path',
];

/** `mcp-auth [auth-code]`: the options 2.x's `mcp-auth` read. */
function parseAuthCodeArgs(args: readonly string[]): McpAuthOptions {
  let serviceKeyPath: string | undefined;
  let envFilePath: string | undefined;
  let outputFile: string | undefined;
  let authType: McpAuthOptions['authType'] = 'abap';
  let browser = 'auto';
  let browserGiven = false;
  let browserProgram: string | undefined;
  let credential = false;
  let format: McpAuthOptions['format'] = 'env';
  let serviceUrl: string | undefined;
  let redirectPort: number | undefined;
  let clientAuth: McpAuthOptions['clientAuth'];
  let basicEncoding: McpAuthOptions['basicEncoding'];
  let certPath: string | undefined;
  let keyPath: string | undefined;
  const debugFlags: DebugFlags = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const next = args[i + 1];
    if (arg === '--credential') {
      credential = true;
      continue;
    }
    if (readDebugFlag(arg, debugFlags)) continue;
    if (next === undefined) {
      throw AUTH_CODE_VALUE_FLAGS.includes(arg)
        ? new UsageError(`${arg} needs a value`)
        : unknownArgument(arg, i);
    }
    switch (arg) {
      case '--service-key':
        serviceKeyPath = next;
        break;
      case '--env':
        envFilePath = next;
        break;
      case '--output':
        outputFile = next;
        break;
      case '--type':
        if (next !== 'abap' && next !== 'xsuaa') {
          throw new UsageError("--type must be 'abap' or 'xsuaa'");
        }
        authType = next;
        break;
      case '--browser':
        browser = next;
        browserGiven = true;
        break;
      case '--browser-program':
        browserProgram = next;
        break;
      case '--format':
        if (next !== 'json' && next !== 'env') {
          throw new UsageError("--format must be 'json' or 'env'");
        }
        format = next;
        break;
      case '--service-url':
        serviceUrl = next;
        break;
      case '--redirect-port':
        redirectPort = portOf(next);
        break;
      case '--client-auth':
        if (next !== 'certificate' && next !== 'secret') {
          throw new UsageError(
            "--client-auth must be 'certificate' or 'secret'",
          );
        }
        clientAuth = next;
        break;
      case '--basic-encoding':
        if (next !== 'raw' && next !== 'form') {
          throw new UsageError("--basic-encoding must be 'raw' or 'form'");
        }
        basicEncoding = next;
        break;
      case '--cert-path':
        certPath = next;
        break;
      case '--key-path':
        keyPath = next;
        break;
      default:
        throw unknownArgument(arg, i);
    }
    i++;
  }

  if (!outputFile) {
    throw new UsageError('--output is required');
  }
  if (!serviceKeyPath && !envFilePath) {
    throw new UsageError('either --service-key or --env must be provided');
  }
  if (browserProgram !== undefined && browserGiven) {
    throw new UsageError('--browser-program excludes --browser');
  }
  return {
    serviceKeyPath,
    envFilePath,
    outputFile,
    authType,
    browser,
    browserProgram,
    credential,
    format,
    serviceUrl,
    redirectPort,
    clientAuth,
    basicEncoding,
    certPath,
    keyPath,
    ...debugFlags,
  };
}

/** `--verbose` and `--auth-debug`: present only when given (§10.7, D17). */
export interface DebugFlags {
  /** `--verbose`: the CLI's logger from `debug`; the broker's logger is it. */
  verbose?: true | undefined;
  /** `--auth-debug`: the broker's `authDebug: true`; implies `--verbose`. */
  authDebug?: true | undefined;
}

/** Reads `arg` into `flags` when it is one of the two; whether it was. */
function readDebugFlag(arg: string, flags: DebugFlags): boolean {
  if (arg === '--verbose') {
    flags.verbose = true;
    return true;
  }
  if (arg === '--auth-debug') {
    flags.authDebug = true;
    return true;
  }
  return false;
}

/** Whether the CLI's logger starts at `debug`: `--verbose`, or `--auth-debug`. */
export function isVerbose(flags: DebugFlags): boolean {
  return flags.verbose === true || flags.authDebug === true;
}

/** A port from 1 to 65535, read as 2.x read it (`parseInt`). */
function portOf(value: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new UsageError('--redirect-port must be a number from 1 to 65535');
  }
  return port;
}

/**
 * Scopes as 2.x split them — on commas and whitespace, empty entries dropped —
 * by walking the string once, with no regular expression.
 */
function parseScopes(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts: string[] = [];
  let current = '';
  for (const character of value) {
    if (character === ',' || character.trim() === '') {
      if (current !== '') parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current !== '') parts.push(current);
  return parts.length > 0 ? parts : undefined;
}

/** The protocol and flow each 2.x `mcp-sso` subcommand stands for. */
const SSO_ROWS: Record<
  SsoSubcommand,
  { protocol: 'oidc' | 'saml2'; flow?: 'pure' | 'bearer' }
> = {
  oidc: { protocol: 'oidc' },
  'saml2-pure': { protocol: 'saml2', flow: 'pure' },
  'saml2-bearer': { protocol: 'saml2', flow: 'bearer' },
};

/** The `McpSsoOptions` fields a flag sets to its value, as given. */
const SSO_VALUE_FLAGS: Record<string, keyof McpSsoOptions> = {
  '--output': 'outputFile',
  '--env': 'envFilePath',
  '--service-key': 'serviceKeyPath',
  '--destination': 'destination',
  '--config': 'configPath',
  '--service-url': 'serviceUrl',
  '--browser': 'browser',
  '--browser-program': 'browserProgram',
  '--redirect-uri': 'redirectUri',
  '--issuer': 'issuerUrl',
  '--authorization-endpoint': 'authorizationEndpoint',
  '--token-endpoint': 'tokenEndpoint',
  '--device-authorization-endpoint': 'deviceAuthorizationEndpoint',
  '--client-id': 'clientId',
  '--client-secret': 'clientSecret',
  '--scope': 'scope',
  '--code': 'code',
  '--username': 'username',
  '--password': 'password',
  '--passcode': 'passcode',
  '--subject-token': 'subjectToken',
  '--subject-token-type': 'subjectTokenType',
  '--audience': 'audience',
  '--actor-token': 'actorToken',
  '--actor-token-type': 'actorTokenType',
  '--idp-sso-url': 'idpSsoUrl',
  '--sp-entity-id': 'spEntityId',
  '--acs-url': 'acsUrl',
  '--relay-state': 'relayState',
  '--assertion': 'assertion',
  '--cookie': 'cookie',
  '--uaa-url': 'uaaUrl',
  '--saml-metadata': 'samlMetadataPath',
  '--idp-entity-id': 'idpEntityId',
  '--authn-request-id': 'authnRequestId',
};

/**
 * `mcp-auth oidc | saml2-pure | saml2-bearer`: 2.1.0's `mcp-sso` options, with
 * the protocol and flow the subcommand names. A flag given no value is read as
 * 2.1.0 read it (the field left unset); an argument no flag takes is refused.
 */
function parseSsoArgs(
  subcommand: SsoSubcommand,
  args: readonly string[],
): McpSsoOptions {
  const row = SSO_ROWS[subcommand];
  const options: McpSsoOptions = {
    authType: 'abap',
    format: 'env',
    protocol: row.protocol,
    flow: row.flow,
  };
  const fields = options as unknown as Record<string, unknown>;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const next = args[i + 1];
    if (readDebugFlag(arg, options)) continue;
    if (Object.hasOwn(SSO_VALUE_FLAGS, arg)) {
      fields[SSO_VALUE_FLAGS[arg] as string] = next;
      i++;
      continue;
    }
    switch (arg) {
      case '--protocol':
        throw new UsageError(
          `--protocol is not accepted: the subcommand is the protocol and flow (mcp-auth ${SUBCOMMANDS.slice(1).join(' | ')})`,
        );
      case '--flow':
        if (row.flow === undefined) {
          options.flow = next as McpSsoOptions['flow'];
        } else if (next !== row.flow) {
          throw new UsageError(
            `--flow: mcp-auth ${subcommand} is the ${row.flow} flow`,
          );
        }
        i++;
        break;
      case '--type':
        if (next !== 'abap' && next !== 'xsuaa') {
          throw new UsageError('--type must be abap or xsuaa');
        }
        options.authType = next;
        i++;
        break;
      case '--format':
        if (next !== 'env' && next !== 'json') {
          throw new UsageError('--format must be env or json');
        }
        options.format = next;
        i++;
        break;
      case '--redirect-port':
        // 2.1.0 skipped the flag when it was last, value-less.
        if (next === undefined) break;
        options.redirectPort = portOf(next);
        i++;
        break;
      case '--scopes':
        options.scopes = parseScopes(next);
        i++;
        break;
      case '--assertion-flow':
        if (next !== 'browser' && next !== 'manual' && next !== 'assertion') {
          throw new UsageError(
            '--assertion-flow must be browser, manual or assertion',
          );
        }
        options.assertionFlow = next;
        i++;
        break;
      case '--idp-cert':
        if (!next || next.startsWith('--')) {
          throw new UsageError('--idp-cert needs a certificate file path');
        }
        // Repeatable: every occurrence adds a certificate, for key rotation.
        options.idpCertificateFiles = [
          ...(options.idpCertificateFiles ?? []),
          next,
        ];
        i++;
        break;
      case '--idp-metadata':
        if (!next || next.startsWith('--')) {
          throw new UsageError(
            '--idp-metadata needs an https URL or a file path',
          );
        }
        options.idpMetadata = next;
        i++;
        break;
      case '--idp-initiated':
        // A flag with no value. Left unset when absent, so a --config file's
        // idpInitiated can still fill it.
        options.idpInitiated = true;
        break;
      default:
        throw unknownArgument(arg, i);
    }
  }
  return options;
}
