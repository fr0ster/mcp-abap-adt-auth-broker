/**
 * The oracle: CLI 2.1.0's `mcp-sso` argument parser, copied from the
 * `auth-broker-cli-v2.1.0` tag (`src/mcp-sso.ts` `parseArgs`, and
 * `parseSamlTrustArg` from `src/mcpSsoConfig.ts`) with only what a test needs
 * changed: the arguments are a parameter instead of `process.argv`, `help` /
 * `version` are left out, and a usage error throws instead of exiting. It is
 * written apart from `subcommandArgs.ts` on purpose: every 2.x form given as
 * its `mcp-auth` form must yield what this yields for the original.
 * Inputs are the tests' own literals.
 */

import type { McpSsoOptions } from '../../mcpSsoConfig';

function parseSamlTrustArg210(
  target: Partial<McpSsoOptions>,
  arg: string,
  next: string | undefined,
): number {
  switch (arg) {
    case '--idp-cert':
      if (!next || next.startsWith('--')) {
        throw new Error('2.1.0: --idp-cert needs a certificate file path.');
      }
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
        throw new Error(
          '2.1.0: --idp-metadata needs an https URL or a file path.',
        );
      }
      target.idpMetadata = next;
      return 1;
    case '--idp-initiated':
      target.idpInitiated = true;
      return 0;
    case '--authn-request-id':
      target.authnRequestId = next;
      return 1;
    default:
      return 0;
  }
}

function parseScopes(value?: string): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}
export function parse210(argv: string[]): McpSsoOptions {
  let args = [...argv];

  let outputFile: string | undefined;
  let envFilePath: string | undefined;
  let destination: string | undefined;
  let serviceKeyPath: string | undefined;
  let authType: 'abap' | 'xsuaa' = 'abap';
  let format: 'env' | 'json' = 'env';
  let protocol: 'oidc' | 'saml2' | undefined;
  let flow: McpSsoOptions['flow'];
  let configPath: string | undefined;
  let serviceUrl: string | undefined;
  let browser: string | undefined;
  let redirectPort: number | undefined;
  let redirectUri: string | undefined;
  let issuerUrl: string | undefined;
  let authorizationEndpoint: string | undefined;
  let tokenEndpoint: string | undefined;
  let deviceAuthorizationEndpoint: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let scopes: string[] | undefined;
  let scope: string | undefined;
  let code: string | undefined;
  let username: string | undefined;
  let password: string | undefined;
  let passcode: string | undefined;
  let subjectToken: string | undefined;
  let subjectTokenType: string | undefined;
  let audience: string | undefined;
  let actorToken: string | undefined;
  let actorTokenType: string | undefined;
  let idpSsoUrl: string | undefined;
  let spEntityId: string | undefined;
  let acsUrl: string | undefined;
  let relayState: string | undefined;
  let assertionFlow: 'browser' | 'manual' | 'assertion' | undefined;
  let assertion: string | undefined;
  let cookie: string | undefined;
  let uaaUrl: string | undefined;
  let samlMetadataPath: string | undefined;
  const samlTrust: Partial<McpSsoOptions> = {};

  const firstArg = args[0];
  if (firstArg && !firstArg.startsWith('-')) {
    if (firstArg === 'oidc') {
      protocol = 'oidc';
    } else if (firstArg === 'saml2') {
      protocol = 'saml2';
    } else if (firstArg === 'bearer') {
      protocol = 'saml2';
      flow = 'bearer';
    } else {
      throw new Error(`2.1.0: Unknown command: ${firstArg}`);
    }
    args = args.slice(1);
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string; // typed for this compiler; i < args.length
    const next = i + 1 < args.length ? args[i + 1] : undefined;

    switch (arg) {
      case '--output':
        outputFile = next;
        i++;
        break;
      case '--env':
        envFilePath = next;
        i++;
        break;
      case '--service-key':
        serviceKeyPath = next;
        i++;
        break;
      case '--destination':
        destination = next;
        i++;
        break;
      case '--type':
        if (next === 'abap' || next === 'xsuaa') {
          authType = next;
        } else {
          throw new Error(`Invalid type: ${next}. Use abap or xsuaa.`);
        }
        i++;
        break;
      case '--format':
        if (next === 'env' || next === 'json') {
          format = next;
        } else {
          throw new Error(`Invalid format: ${next}. Use env or json.`);
        }
        i++;
        break;
      case '--protocol':
        if (next === 'oidc' || next === 'saml2') {
          protocol = next;
        } else {
          throw new Error(`Invalid protocol: ${next}. Use oidc or saml2.`);
        }
        i++;
        break;
      case '--flow':
        flow = next as McpSsoOptions['flow'];
        i++;
        break;
      case '--config':
        configPath = next;
        i++;
        break;
      case '--service-url':
        serviceUrl = next;
        i++;
        break;
      case '--browser':
        browser = next;
        i++;
        break;
      case '--redirect-port':
        if (!next) break;
        redirectPort = parseInt(next, 10);
        if (
          Number.isNaN(redirectPort) ||
          redirectPort < 1 ||
          redirectPort > 65535
        ) {
          throw new Error(`Invalid redirect port: ${next}`);
        }
        i++;
        break;
      case '--redirect-uri':
        redirectUri = next;
        i++;
        break;
      case '--issuer':
        issuerUrl = next;
        i++;
        break;
      case '--authorization-endpoint':
        authorizationEndpoint = next;
        i++;
        break;
      case '--token-endpoint':
        tokenEndpoint = next;
        i++;
        break;
      case '--device-authorization-endpoint':
        deviceAuthorizationEndpoint = next;
        i++;
        break;
      case '--client-id':
        clientId = next;
        i++;
        break;
      case '--client-secret':
        clientSecret = next;
        i++;
        break;
      case '--scopes':
        scopes = parseScopes(next);
        i++;
        break;
      case '--scope':
        scope = next;
        i++;
        break;
      case '--code':
        code = next;
        i++;
        break;
      case '--username':
        username = next;
        i++;
        break;
      case '--password':
        password = next;
        i++;
        break;
      case '--passcode':
        passcode = next;
        i++;
        break;
      case '--subject-token':
        subjectToken = next;
        i++;
        break;
      case '--subject-token-type':
        subjectTokenType = next;
        i++;
        break;
      case '--audience':
        audience = next;
        i++;
        break;
      case '--actor-token':
        actorToken = next;
        i++;
        break;
      case '--actor-token-type':
        actorTokenType = next;
        i++;
        break;
      case '--idp-sso-url':
        idpSsoUrl = next;
        i++;
        break;
      case '--sp-entity-id':
        spEntityId = next;
        i++;
        break;
      case '--acs-url':
        acsUrl = next;
        i++;
        break;
      case '--relay-state':
        relayState = next;
        i++;
        break;
      case '--assertion-flow':
        if (next === 'browser' || next === 'manual' || next === 'assertion') {
          assertionFlow = next;
        } else {
          throw new Error(
            `Invalid assertion flow: ${next}. Use browser, manual, or assertion.`,
          );
        }
        i++;
        break;
      case '--assertion':
        assertion = next;
        i++;
        break;
      case '--cookie':
        cookie = next;
        i++;
        break;
      case '--uaa-url':
        uaaUrl = next;
        i++;
        break;
      case '--saml-metadata':
        samlMetadataPath = next;
        i++;
        break;
      default:
        i += parseSamlTrustArg210(samlTrust, arg, next);
        break;
    }
  }

  return {
    outputFile,
    envFilePath,
    destination,
    serviceKeyPath,
    authType,
    format,
    protocol,
    flow: flow as McpSsoOptions['flow'],
    configPath,
    serviceUrl,
    browser,
    redirectPort,
    redirectUri,
    issuerUrl,
    authorizationEndpoint,
    tokenEndpoint,
    deviceAuthorizationEndpoint,
    clientId,
    clientSecret,
    scopes,
    scope,
    code,
    username,
    password,
    passcode,
    subjectToken,
    subjectTokenType,
    audience,
    actorToken,
    actorTokenType,
    idpSsoUrl,
    spEntityId,
    acsUrl,
    relayState,
    assertionFlow,
    assertion,
    cookie,
    uaaUrl,
    samlMetadataPath,
    ...samlTrust,
  };
}
