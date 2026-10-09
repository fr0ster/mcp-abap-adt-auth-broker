/**
 * What `mcp-auth oidc | saml2-pure | saml2-bearer` do once their arguments
 * are parsed (`subcommandArgs.ts`) — 2.x's `mcp-sso` — importable by tests.
 *
 * A run writes a complete destination: first its means, through the
 * key store's own write method — `authType`, `grantType`, the grant's data, the
 * client — then the login, through the provider the broker builds for that
 * destination with the collaborators this CLI states, whose secret reaches the
 * session store through the broker's persistence. `flush()` before the output
 * is written: a secret the store did not take is a failed run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AuthBroker, bindingOf } from '@mcp-abap-adt/auth-broker';
import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';
import {
  type EnvDestinationStore,
  XsuaaServiceKeyStore,
} from '@mcp-abap-adt/auth-stores';
import type { ILogger } from '@mcp-abap-adt/interfaces-utils';
import { clientAuthenticationStrategy } from './clientAuthentication';
import {
  authenticatedJsonOutput,
  completeMeans,
  flushed,
  openDestination,
  writeJsonFile,
  writeOutputFile,
} from './destination';
import { readJsonFile } from './jsonFile';
import {
  applyFileConfig,
  buildCollaborators,
  buildDestinationMeans,
  declaredAcs,
  type McpSsoOptions,
  normalizeProviderConfig,
  opensBrowser,
  pastesSamlResponse,
  type SsoRow,
  ssoBrowser,
  ssoRow,
} from './mcpSsoConfig';
import { printFailure, progress } from './output';
import { applySamlMetadata, loadMetadata } from './samlMetadata';
import { sessionClientAuth } from './sessionClientAuth';
import {
  noGrantRefusal,
  processEnvironment,
  type RunSource,
  resolveSource,
  type SourceEnvironment,
} from './source';
import { UsageError } from './subcommandArgs';
import { withoutTrailingSlashes } from './urlText';

/**
 * The flags that state means (`buildDestinationMeans` reads them), each by
 * the name the user typed. With no source they are the run's means — a fresh
 * login, as with a service key; beside a session file (`--env`, or
 * `--destination` finding one) each is refused (D25): the file is used as it
 * is. The rest — the flow, the browser, a one-time code or passcode, an
 * assertion — run the login and state nothing a destination keeps; nor does
 * `--cookie`, which hands over the secret itself.
 */
const MEANS_FLAGS = {
  configPath: '--config',
  serviceUrl: '--service-url',
  issuerUrl: '--issuer',
  authorizationEndpoint: '--authorization-endpoint',
  tokenEndpoint: '--token-endpoint',
  deviceAuthorizationEndpoint: '--device-authorization-endpoint',
  clientId: '--client-id',
  clientSecret: '--client-secret',
  scopes: '--scopes',
  scope: '--scope',
  username: '--username',
  password: '--password',
  subjectToken: '--subject-token',
  subjectTokenType: '--subject-token-type',
  audience: '--audience',
  actorToken: '--actor-token',
  actorTokenType: '--actor-token-type',
  idpSsoUrl: '--idp-sso-url',
  spEntityId: '--sp-entity-id',
  acsUrl: '--acs-url',
  relayState: '--relay-state',
  uaaUrl: '--uaa-url',
  samlMetadataPath: '--saml-metadata',
  // Inline certificates come only from a --config file.
  idpCertificates: '--config',
  idpCertificateFiles: '--idp-cert',
  idpEntityId: '--idp-entity-id',
  idpMetadata: '--idp-metadata',
  idpInitiated: '--idp-initiated',
} as const satisfies Partial<Record<keyof McpSsoOptions, string>>;

/** Refuses the first means flag given beside a session file, naming both. */
function refuseMeansBesideSession(
  options: McpSsoOptions,
  flag: '--env' | '--destination',
): void {
  for (const [field, name] of Object.entries(MEANS_FLAGS)) {
    if (options[field as keyof typeof MEANS_FLAGS] !== undefined) {
      throw new UsageError(
        `${name} and ${flag}: the session file holds the means and is used as it is; state the means with --service-key or flags alone instead`,
      );
    }
  }
}

/** The subcommand and flow each grant a destination states is run by. */
const FLOW_OF_GRANT: Partial<
  Record<string, { protocol: 'oidc' | 'saml2'; flow: McpSsoOptions['flow'] }>
> = {
  oidc_authorization_code: { protocol: 'oidc', flow: 'browser' },
  device_code: { protocol: 'oidc', flow: 'device' },
  password: { protocol: 'oidc', flow: 'password' },
  passcode: { protocol: 'oidc', flow: 'password' },
  token_exchange: { protocol: 'oidc', flow: 'token_exchange' },
  saml2_pure: { protocol: 'saml2', flow: 'pure' },
  none: { protocol: 'saml2', flow: 'pure' },
  saml2_bearer: { protocol: 'saml2', flow: 'bearer' },
};

function subcommandText(options: McpSsoOptions): string {
  if (options.protocol === 'oidc') {
    return options.flow === undefined
      ? 'mcp-auth oidc'
      : `mcp-auth oidc --flow ${options.flow}`;
  }
  return `mcp-auth saml2-${options.flow}`;
}

/**
 * The row a session file states, checked against the subcommand: its grant
 * must be one this subcommand runs, and an `oidc` run without `--flow` takes
 * the file's. What a pasted SAML login needs of the means — the ACS, whether
 * the identity provider starts it — is read from the file where the run does
 * not state it.
 */
async function sessionRow(
  options: McpSsoOptions,
  source: Extract<RunSource, { kind: 'session' }>,
  means: SessionMeans,
): Promise<SsoRow> {
  const grant = means?.grantType;
  const authType = means?.authType;
  if (grant === undefined || (authType !== 'jwt' && authType !== 'saml')) {
    throw noGrantRefusal(source.sessionPath, options.authType, source.flag);
  }
  const runs = FLOW_OF_GRANT[grant];
  const flowGiven = options.flow !== undefined;
  if (
    runs === undefined ||
    runs.protocol !== options.protocol ||
    (flowGiven && runs.flow !== options.flow)
  ) {
    throw new UsageError(
      `${source.flag}: the session file states the grant ${grant}, not ${subcommandText(options)}`,
    );
  }
  options.flow = runs.flow;
  options.acsUrl ??= means?.samlAcsUrl;
  options.idpInitiated ??= means?.samlIdpInitiated;
  return { authType, grantType: grant };
}

/** The means a session file states, as its key store reads them. */
type SessionMeans = Awaited<
  ReturnType<EnvDestinationStore['getConnectionConfig']>
>;

/**
 * The means of the exact session file the run names, read from the run's
 * private copy of it (`openDestination`) — never by a directory store over
 * the file's own folder, which would read `<name>.env` beside it instead.
 */
async function sessionMeans(
  options: McpSsoOptions,
  source: Extract<RunSource, { kind: 'session' }>,
  workDir: string,
): Promise<SessionMeans> {
  const copy = openDestination(
    workDir,
    source.destination,
    options.authType,
    source.sessionPath,
  );
  return copy.keyStore.getConnectionConfig(source.destination);
}

export interface McpSsoContext {
  /** The CLI's logger (stderr): the broker's, and the providers' it builds. */
  logger: ILogger;
  /** The run's private directory (`createWorkDir`), removed by its creator. */
  workDir: string;
  /** The platform the browser is mapped for; `process.platform` when absent. */
  platform?: string | undefined;
  /**
   * Where `--destination` looks; the process's own when absent, read only
   * when needed.
   */
  environment?: SourceEnvironment | undefined;
  /**
   * The run's signal (`underInterrupt`): every wait of the run takes it —
   * the broker's calls, the provider's login, the strategies and the
   * terminal reads. Absent: nothing ends the login but its result.
   */
  signal?: AbortSignal | undefined;
}

/** Runs one of those subcommands; resolves the exit code. Usage errors exit the process. */
export async function runMcpSso(
  options: McpSsoOptions,
  { logger, workDir, platform, signal, environment }: McpSsoContext,
): Promise<number> {
  // The run's source (D25): a service key (a new login), a session file
  // (reused, refreshed or logged in, written back), or none — the run states
  // its means by flags or --config and logs in, as with a service key.
  const source = resolveSource(
    options,
    options.outputFile,
    () => environment ?? processEnvironment(),
  );
  const output = source?.output ?? options.outputFile;
  if (!output) {
    console.error('❌ Missing required --output');
    process.exit(1);
  }
  const resolvedOutputPath = path.resolve(output);
  if (
    source?.kind === 'session' &&
    options.format === 'json' &&
    options.outputFile === undefined
  ) {
    throw new UsageError(
      '--format json needs --output: the session file is written back as .env',
    );
  }
  // A service key's path, for every check below that asks whether the run
  // has one; a session file is the seed, nothing else.
  options.serviceKeyPath =
    source?.kind === 'service-key' ? source.serviceKeyPath : undefined;
  const resolvedEnvPath =
    source?.kind === 'session' ? source.sessionPath : undefined;
  const destination =
    source?.destination ??
    path.basename(resolvedOutputPath, path.extname(resolvedOutputPath));
  if (options.serviceKeyPath && !fs.existsSync(options.serviceKeyPath)) {
    console.error(`❌ Service key file not found: ${options.serviceKeyPath}`);
    process.exit(1);
  }

  // A session file states its means (D25) and is used as it is: a flag that
  // states means beside it is refused; the subcommand is checked against the
  // file's grant.
  if (source?.kind === 'session') {
    refuseMeansBesideSession(options, source.flag);
  }
  // Cookies handed over beside a session file (`saml2-pure --cookie`) are
  // the secret, not means: the file's means stay as they are — its system,
  // SAP client included — and only the row they are presented under becomes
  // the handover's, `saml/none`, so the broker binds them with `bindingOf`.
  const handsOverCookies =
    options.cookie !== undefined &&
    options.protocol === 'saml2' &&
    options.flow === 'pure';
  const means =
    source?.kind === 'session'
      ? await sessionMeans(options, source, workDir)
      : undefined;
  // Only a cookie session takes handed-over cookies: a destination of any
  // other grant is never turned into one.
  if (source?.kind === 'session' && handsOverCookies) {
    const grant = means?.grantType;
    const cookieSession =
      grant === undefined ||
      (means?.authType === 'saml' &&
        (grant === 'none' || grant === 'saml2_pure'));
    if (!cookieSession) {
      throw new UsageError(
        `--cookie and ${source.flag}: the session file states the grant ${grant}; cookies are handed over only to a cookie session (saml2_pure or none)`,
      );
    }
  }
  const cookiesOverSession = source?.kind === 'session' && handsOverCookies;
  const fileRow: SsoRow | undefined =
    source?.kind !== 'session'
      ? undefined
      : cookiesOverSession
        ? { authType: 'saml', grantType: 'none' }
        : await sessionRow(options, source, means ?? null);

  const allowTokenEndpointWithServiceKey =
    options.protocol === 'saml2' && options.flow === 'bearer';
  const serviceKeyConflicts =
    options.serviceKeyPath &&
    (options.configPath ||
      options.issuerUrl ||
      options.authorizationEndpoint ||
      (!allowTokenEndpointWithServiceKey && options.tokenEndpoint) ||
      options.deviceAuthorizationEndpoint ||
      options.clientId ||
      options.clientSecret ||
      options.uaaUrl);
  if (serviceKeyConflicts) {
    console.error(
      '❌ Use either --service-key or explicit OIDC/SAML parameters (issuer/token/client/uaa).',
    );
    process.exit(1);
  }

  if (options.serviceKeyPath && options.authType !== 'xsuaa') {
    console.error('❌ --service-key is supported only for XSUAA flows.');
    process.exit(1);
  }

  let providerConfigFromFile: ReturnType<typeof normalizeProviderConfig> = null;
  if (options.configPath) {
    const resolvedConfigPath = path.resolve(options.configPath);
    if (!fs.existsSync(resolvedConfigPath)) {
      console.error(`❌ Config file not found: ${resolvedConfigPath}`);
      process.exit(1);
    }
    // Read in fixed words: the parser's message would quote the file.
    let raw: unknown;
    try {
      raw = readJsonFile(resolvedConfigPath, 'The config file');
    } catch (error) {
      printFailure(error);
      process.exit(1);
    }
    providerConfigFromFile = normalizeProviderConfig(raw);
    if (!providerConfigFromFile) {
      console.error('❌ --config: the file holds no JSON object');
      process.exit(1);
    }
  }

  // Merge the file into `options` *before* anything downstream reads
  // options.protocol/flow or builds a strategy from them — a run driven by
  // --config must reach exactly the same validation and destination-building
  // code a run given every flag does; a file naming another subcommand is
  // refused there. CLI flags already
  // parsed are left alone; the file only fills what they didn't set. A no-op
  // when --config wasn't given.
  applyFileConfig(options, providerConfigFromFile);

  // A pasted SAML login declares its ACS (§10.5), refused naming --acs-url
  // before anything is read or fetched. The --config file, read above, is
  // one source; the other is the SP metadata — only saml2-bearer's, and only
  // when the run names one (--saml-metadata, a UAA URL, --service-key) — so
  // such a run is checked once that metadata has been read, below.
  const spMetadataStated =
    options.flow === 'bearer' &&
    (options.samlMetadataPath !== undefined ||
      options.uaaUrl !== undefined ||
      options.serviceKeyPath !== undefined);
  if (pastesSamlResponse(options) && !spMetadataStated) {
    declaredAcs(options);
  }

  // The browser is mapped only for a login that opens one — what the run
  // states, from a flag or the --config file, else `auto` — and then before
  // anything else is read or written: a name this platform has no launcher
  // for is a usage error, never a guess. A login that opens none maps no
  // browser and refuses none.
  try {
    if (opensBrowser(options)) {
      ssoBrowser(options, platform ?? process.platform);
    }
  } catch (error) {
    printFailure(error);
    process.exit(1);
  }

  // The user's own --token-endpoint, before a service key sets the plain
  // /oauth/token, which a saml2-bearer grant must not use.
  const explicitTokenEndpoint = options.tokenEndpoint;

  if (options.serviceKeyPath) {
    const resolvedServiceKeyPath = path.resolve(options.serviceKeyPath);
    const serviceKeyStore = new XsuaaServiceKeyStore(
      path.dirname(resolvedServiceKeyPath),
    );
    const authConfig =
      await serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      console.error(
        `❌ Authorization config not found for ${destination}. Service key must contain clientid, clientsecret, and url fields.`,
      );
      process.exit(1);
    }
    const uaaUrl = authConfig.uaaUrl;
    if (!uaaUrl) {
      console.error(`❌ Service key missing UAA URL for ${destination}.`);
      process.exit(1);
    }
    options.uaaUrl = uaaUrl;
    options.clientId = authConfig.uaaClientId;
    options.clientSecret = authConfig.uaaClientSecret;
    if (!options.issuerUrl) {
      options.issuerUrl = uaaUrl;
    }
    if (!options.tokenEndpoint) {
      options.tokenEndpoint = `${withoutTrailingSlashes(uaaUrl)}/oauth/token`;
    }
    if (!options.authorizationEndpoint) {
      options.authorizationEndpoint = `${withoutTrailingSlashes(uaaUrl)}/oauth/authorize`;
    }
  }

  // What the SAML metadata states and the caller did not: the identity
  // provider's trust from --idp-metadata, and for saml2-bearer the Audience,
  // Recipient and token endpoint from XSUAA's own metadata (--saml-metadata,
  // else <uaa.url>/saml/metadata from the service key).
  // The run's signal ends a metadata fetch or body read in flight (§10.4).
  try {
    await applySamlMetadata(
      options,
      explicitTokenEndpoint,
      loadMetadata,
      signal,
    );
  } catch (error) {
    // Interrupted: the run's interrupt reports it, never this catch.
    if (signal?.aborted) throw error;
    // The CLI's own words, else auth-errors': never a fetch's or a file
    // reader's message, which may quote what a server answered.
    printFailure(error, { context: 'SAML metadata' });
    process.exit(1);
  }

  if (options.protocol === 'oidc' && options.flow) {
    const valid = ['browser', 'device', 'password', 'token_exchange'];
    if (!valid.includes(options.flow)) {
      console.error(
        `❌ Invalid OIDC flow: ${options.flow}. Use one of: ${valid.join(', ')}`,
      );
      process.exit(1);
    }
  }
  if (options.protocol === 'saml2' && options.flow) {
    const valid = ['bearer', 'pure'];
    if (!valid.includes(options.flow)) {
      console.error(
        `❌ Invalid SAML flow: ${options.flow}. Use one of: ${valid.join(', ')}`,
      );
      process.exit(1);
    }
  }

  if (
    options.protocol === 'saml2' &&
    options.flow === 'pure' &&
    options.authType === 'xsuaa'
  ) {
    console.error(
      '❌ SAML pure flow is only supported for ABAP sessions (cookies)',
    );
    process.exit(1);
  }

  // The same check once the SP metadata is merged: a bearer run that names
  // its metadata, refused before the destination is read or written.
  if (pastesSamlResponse(options)) {
    declaredAcs(options);
  }

  const files = openDestination(
    workDir,
    destination,
    options.authType,
    resolvedEnvPath,
  );

  // An ABAP session is presented to a system: its URL is required, from
  // --service-url or the destination given with --env.
  if (options.authType === 'abap' && !options.serviceUrl) {
    const stated = await files.keyStore.getConnectionConfig(destination);
    if (!stated?.serviceUrl) {
      console.error(
        '❌ ABAP requires --service-url or existing env with SAP URL',
      );
      process.exit(1);
    }
  }

  const row = fileRow ?? ssoRow(options);
  if (fileRow === undefined) {
    const stated = buildDestinationMeans(options);
    await files.keyStore.setDestination(destination, completeMeans(stated));
  } else if (cookiesOverSession) {
    // The handover's row, and nothing else: every other means field of the
    // file — its system, SAP client, IdP, ACS, trust — stays as it is.
    await files.keyStore.setDestination(destination, {
      authType: 'saml',
      grantType: 'none',
    });
  }
  progress(
    `📝 Destination "${destination}": ${row.authType} / ${row.grantType}`,
  );

  // This CLI's choices, stated: a user at a terminal can log in, so a
  // renewal refreshes and then logs in; a secret the store did not take
  // fails the run, which then writes no output.
  // A session file's client authentication is the file's (D25): its
  // certificate, or the Basic encoding it records. None without one.
  const clientAuth =
    resolvedEnvPath === undefined || source?.kind !== 'session'
      ? {}
      : sessionClientAuth(files.file, options.authType, source.flag);
  const broker = new AuthBroker(
    {
      sessionStore: files.sessionStore,
      serviceKeyStore: files.keyStore,
      ...buildCollaborators(options, signal),
      clientAuthentication: clientAuthenticationStrategy(clientAuth),
      renewal: () => refreshThenLogin(),
      onWriteFailure: 'fail',
      // On only with --auth-debug (§10.7): never from the environment.
      authDebug: options.authDebug === true,
    },
    logger,
  );

  if (row.grantType === 'none') {
    // The cookies were handed over, not obtained: the CLI writes them, with
    // the binding the broker computes for this destination's means — the
    // resource with its SAP client — so the broker presents them there and
    // nowhere else. The CLI composes no binding of its own. The store
    // merges, so the write states everything a credential write states
    // (§5.2, §6.4): both binding fields (`issuedFor` '' when the means lack
    // its source) and `refreshToken: ''` — SAML has none, and one left
    // beside earlier cookies or a token is not this credential's.
    // A session file's cookies, with none handed over, stay as they are.
    if (options.cookie !== undefined) {
      const stated = await files.keyStore.getConnectionConfig(destination);
      const binding = bindingOf(stated ?? {});
      await files.sessionStore.saveSession(destination, {
        sessionCookies: options.cookie,
        refreshToken: '',
        issuedFor: binding.issuedFor ?? '',
        issuedBy: binding.issuedBy ?? '',
      });
    }
    // The destination as the broker will read it: refused here, not later.
    await broker.getProvider(destination, { signal });
    progress(
      options.cookie === undefined
        ? '✅ Session cookies kept'
        : '✅ Session cookies stored',
    );
  }
  // Whether the login threw, beside what it threw: a falsy value thrown
  // (undefined, 0, '') is a failure too.
  let failed = false;
  let obtainError: unknown;
  if (row.grantType !== 'none') {
    const provider = await broker.getProvider(destination, { signal });
    const tokens = provider as Partial<{
      getTokens: (options?: { signal?: AbortSignal }) => Promise<unknown>;
    }>;
    if (typeof tokens.getTokens !== 'function') {
      throw new UsageError(
        `The provider for "${destination}" obtains no token (${row.authType} / ${row.grantType})`,
      );
    }
    progress(`🔐 Getting token for destination "${destination}"...`);
    // What the provider obtains reaches the session store through the
    // broker's persistence; a write that did not land fails this call
    // (onWriteFailure: 'fail'). Either way the run fails, after one more
    // attempt at any write still pending.
    try {
      await tokens.getTokens(signal === undefined ? undefined : { signal });
      progress(`✅ Token obtained successfully`);
    } catch (error) {
      failed = true;
      obtainError = error;
    }
  }

  const stored = await flushed(broker, signal);
  if (failed) {
    throw obtainError;
  }
  if (!stored) {
    return 1;
  }
  if (options.format === 'env') {
    // An interrupted run writes no output: checked with nothing awaited
    // between the check and the write.
    signal?.throwIfAborted();
    writeOutputFile(files, resolvedOutputPath);
    progress(`✅ .env file created: ${resolvedOutputPath}`);
  } else {
    const json = await authenticatedJsonOutput(
      files,
      destination,
      { tokenType: true },
      clientAuth,
    );
    // An interrupted run writes no output: checked after the last await.
    signal?.throwIfAborted();
    writeJsonFile(resolvedOutputPath, json);
    progress(`✅ JSON file created: ${resolvedOutputPath}`);
  }
  return 0;
}
