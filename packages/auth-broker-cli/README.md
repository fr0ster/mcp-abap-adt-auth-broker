# @mcp-abap-adt/auth-broker-cli
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

The `mcp-auth` command: log in to a SAP BTP or ABAP destination and write it — the destination's
means and the secret the login obtained — to one `.env` (or JSON) file, through
[`@mcp-abap-adt/auth-broker`](../auth-broker/README.md).

```
mcp-auth [auth-code]     UAA authorization code, or --credential client credentials (a service key)
mcp-auth oidc            the OIDC grants (browser, device, password, token exchange) and the UAA passcode
mcp-auth saml2-pure      SAML → the system's session cookies; --cookie hands cookies over
mcp-auth saml2-bearer    a SAML assertion exchanged for an OAuth token
```

**Upgrading from 2.x?** 3.0.0 is a major: it is **one command** — the `mcp-sso` command is gone,
and every form of it is an `mcp-auth` subcommand with the same flags — a run takes exactly one
source (`--service-key`, `--env` or `--destination`), a login waits until you end it, and only
`help` and `--version` go to stdout. See [*Migrating to 3.0.0*](#migrating-to-300).

## Installation

```bash
npm install -g @mcp-abap-adt/auth-broker-cli
```

3.0.0 depends on `@mcp-abap-adt/auth-broker` `^5.0.0`, `@mcp-abap-adt/auth-providers`
`^6.0.0`, `@mcp-abap-adt/auth-stores` `^4.0.0`, `@mcp-abap-adt/auth-errors` `^2.1.1`,
`@mcp-abap-adt/interfaces-auth` `^7.5.0`, `@mcp-abap-adt/interfaces-utils` `^1.1.0`,
`@xmldom/xmldom` (SAML metadata) and `dotenv` (reading a session file as auth-stores does). Its
only bin is `mcp-auth`. Requires Node.js 22, 24 or 26 (`engines: "^22 || ^24 || ^26"`).

From a clone: `npm ci` and `npm run build` at the repository root; the command is then
`node packages/auth-broker-cli/dist/mcp-auth.js`.

## Where a Run's Destination Comes From

Every subcommand takes **exactly one source**; two together are a usage error naming both.

| Source | What the run does |
|---|---|
| `--service-key <path>` | A SAP service key: the means come from the key, and **every run logs in** and writes a new token and refresh token to `--output` (required). No stored session is read — not even an existing `--output` file. |
| `--env <path>` | A session file, anywhere, holding both the means (`SAP_AUTH_TYPE`, `SAP_GRANT_TYPE`, `SAP_UAA_*`, `SAP_URL`, …) and the session. The broker decides: a valid token bound to the file's means is reused with **no request**, an expired one is refreshed, and a refused refresh — or none, or a session not bound to these means — logs in. The result is written back to that file, or to `--output` when given. The file is read exactly as named (`.env`, `session.backup`), never a `<name>.env` beside it. |
| `--destination <name>` | A destination of the destination folder: `<dir>/sessions/<name>.env` when it exists (handled as `--env`), else `<dir>/service-keys/<name>.json` (handled as `--service-key`, the session written to `<dir>/sessions/<name>.env`). |
| none (`oidc`, `saml2-pure`, `saml2-bearer` only) | The means come from flags or `--config`: like `--service-key` — a fresh login, a new pair written to `--output`, no session read even when `--output` names an existing file. |

**The destination folder `<dir>`**, the first that is given:

1. `--destination-dir <dir>`;
2. the environment variable `AUTH_BROKER_PATH` — the variable the server `mcp-abap-adt` reads
   for the same folder, so the CLI and the server see the same destinations. Like the server's,
   it may list several base folders, separated by `;` (on Unix also `:`); an entry ending in the
   subfolder looked for (`sessions`, `service-keys`) is read as its parent; a session in any
   folder is used before a service key in any folder, and a new session is written to the first
   sessions folder;
3. the standard folder: `~/.config/mcp-abap-adt` on Unix, `<home>\Documents\mcp-abap-adt` on
   Windows.

`AUTH_BROKER_PATH` is the one environment variable the CLI reads, and only for `--destination`
without `--destination-dir`.

**A session file is used as it is.** Beside `--env` (or a session `--destination` finds), any
flag that states means — `--credential`, `--service-url`, `--client-auth`, `--basic-encoding`,
`--cert-path`, `--key-path`, `--config`, and every OIDC and SAML means flag (`--issuer`,
`--client-id`, `--idp-cert`, `--acs-url`, …) — is a usage error naming both: the means are the
file's, client authentication included (its certificate paths, or the Basic encoding it
records). To log in anew, run with `--service-key`. **`--cookie` is the one exception**: it hands
over the secret, not means, so `saml2-pure --cookie` is accepted beside a session file whose
grant is `saml/none` or `saml/saml2_pure` (or that states none); the run changes only the row to
`saml/none`, keeps every other means field, binds the cookies to them and writes them back. Beside
any other grant it is a usage error naming `--cookie` and the grant.

```bash
# A fresh login from a service key, written to ./mcp.env
mcp-auth --service-key ./service-key.json --output ./mcp.env --type xsuaa

# The same file later: its token reused, refreshed, or a login — only as needed
mcp-auth --env ./mcp.env --type xsuaa

# The destination TRIAL of the destination folder: its session, else its service key
mcp-auth --destination TRIAL --type xsuaa
mcp-auth --destination TRIAL --destination-dir ~/work/destinations --type abap
```

## What Each Run Writes, and Where

**Files.** A run writes one destination in two roles that two stores of
`@mcp-abap-adt/auth-stores` own — the same file layout the server and the broker read:

- **The means** — how the secret is obtained: `SAP_AUTH_TYPE`, `SAP_GRANT_TYPE`, the grant's data
  (`SAP_OIDC_*`, `SAP_SAML_*`, `SAP_USERNAME` / `SAP_PASSWORD`), the client (`SAP_UAA_URL`,
  `SAP_UAA_CLIENT_ID`, `SAP_UAA_CLIENT_SECRET` — or, with `--client-auth certificate`,
  `SAP_UAA_CLIENT_CERT_PATH`, `SAP_UAA_CLIENT_KEY_PATH`, `SAP_UAA_CERT_URL` in its place) and
  `SAP_URL`. Written first, through `EnvDestinationStore.setDestination`, before the login; a run
  from a session file keeps the file's.
- **The secret** — what the login obtained: `SAP_JWT_TOKEN` or `SAP_SESSION_COOKIES_B64`,
  `SAP_EXPIRES_AT`, `SAP_REFRESH_TOKEN`, and what it is bound to, `SAP_ISSUED_FOR` /
  `SAP_ISSUED_BY` (auth-broker 5's binding record). Written only by the broker's persistence, as
  it stores what a provider obtains — never by the command itself (the one exception:
  `--cookie`). The session store refuses means, so the client secret never reaches it.

With `--type xsuaa` the keys are `XSUAA_*` (the URL is `XSUAA_MCP_URL`); `--type` (default
`abap`) must match the keys of a file given with `--env`. Each store touches only its own keys,
so every other line of the file stays.

| Run | `SAP_AUTH_TYPE` / `SAP_GRANT_TYPE` | Means written | Secret (from the login) |
|---|---|---|---|
| `mcp-auth` / `mcp-auth auth-code` | `jwt` / `authorization_code` | the service key's client, `SAP_URL` (`--service-url` or the key) | token, refresh token, expiry, binding |
| `mcp-auth --credential` | `jwt` / `client_credentials` | the same | token, expiry, binding |
| `mcp-auth oidc --flow browser` | `jwt` / `oidc_authorization_code` | `SAP_OIDC_ISSUER_URL`, `…_AUTHORIZATION_ENDPOINT`, `…_TOKEN_ENDPOINT`, `…_SCOPES`, the client | token, refresh token, expiry, binding |
| `mcp-auth oidc --flow device` | `jwt` / `device_code` | `SAP_OIDC_ISSUER_URL`, `…_DEVICE_AUTHORIZATION_ENDPOINT`, `…_TOKEN_ENDPOINT`, `…_SCOPES`, the client | the same |
| `mcp-auth oidc --flow password` | `jwt` / `password` | `SAP_USERNAME`, `SAP_PASSWORD`, `SAP_OIDC_ISSUER_URL`, `…_TOKEN_ENDPOINT`, `…_SCOPES`, the client | the same |
| `mcp-auth oidc --flow password --passcode <p>` (or neither `--password` nor `--username`) | `jwt` / `passcode` | the client: `--uaa-url` (or `--service-key`), `--client-id` — never the one-time code | the same |
| `mcp-auth oidc --flow token_exchange` | `jwt` / `token_exchange` | `SAP_OIDC_SUBJECT_TOKEN`, `…_SUBJECT_TOKEN_TYPE`, `…_AUDIENCE`, `…_ACTOR_TOKEN(_TYPE)`, `…_TOKEN_ENDPOINT`, `…_SCOPES` (`--scope`), the client | the same |
| `mcp-auth saml2-pure` | `saml` / `saml2_pure` | `SAP_SAML_IDP_SSO_URL`, `…_IDP_ENTITY_ID`, `…_IDP_CERTIFICATES_B64`, `…_SP_ENTITY_ID`, `…_ACS_URL`, `…_RELAY_STATE`, `…_IDP_INITIATED` | cookies, expiry, binding |
| `mcp-auth saml2-pure --cookie …` | `saml` / `none` | `SAP_URL` (beside a session file: its means, kept) | the cookies you handed over, bound with the broker's `bindingOf` and `SAP_REFRESH_TOKEN` cleared — stored by the command, since no login obtains them |
| `mcp-auth saml2-bearer` | `saml` / `saml2_bearer` | the `SAP_SAML_*` fields above, `SAP_SAML_TOKEN_URL`, the client (`--uaa-url`, `--client-id`, or `--service-key`) | token, refresh token, expiry, binding |

`saml2-pure` writes ABAP sessions (`--type abap`) only. The client secret you give (a service
key's, or `--client-id` with `--client-secret`), a password, a subject or actor token are means:
they are written because you asked for a destination that can renew. A public client (no
`--client-secret`) is written as `SAP_UAA_CLIENT_SECRET=` — the secret `''`. A client that
authenticates with its certificate is written as the two PEM files' absolute paths and
`certurl`, and no client secret. `--basic-encoding` is recorded as `SAP_UAA_BASIC_ENCODING`
(`XSUAA_UAA_BASIC_ENCODING`) — **a line only this CLI reads**: auth-stores and the server do
not; a server reading the destination composes its own client authentication.

**When the output is written, and the exit code.** A run works on a copy in a private temporary
directory (mode `0700`, removed however the run ends, signals included) and copies the
destination to its output only once the broker's `flush()` reports the secret stored. A failed
login, a secret the store did not take, or an interrupted run leaves the output as it was.
`--format json` writes, from the same stores, the fields `accessToken` or `sessionCookies`,
`refreshToken`, `serviceUrl`, `uaaUrl`, `uaaClientId`, `uaaClientSecret` (`oidc` / `saml2-*` add
`tokenType`); a certificate client adds `uaaClientCertPath`, `uaaClientKeyPath`, `uaaCertUrl`,
and `--client-auth secret` adds `uaaBasicEncoding` — never PEM.

| Exit code | When |
|---|---|
| `0` | the secret is stored and the output written; `help`, `--version` |
| `1` | a usage error, a failed login, a secret not stored |
| `130` / `143` | `SIGINT` (Ctrl+C) / `SIGTERM` ended the login |
| `129` | `SIGHUP` |

**stdout** carries only what was asked for: `help` and `--version`. **stderr** carries everything
else: progress lines (the destination's name, the flow, the paths of your own files), the
providers' prompts (the authorization URL you must open, the passcode page, the device code),
the questions of a pasted login, log lines and failures. A run never prints a token, a refresh
token, a client secret, a store's or a server's text, or an authorization URL of its own: the
one place the URL appears, `state` included, is the provider's prompt that sends you there, on
stderr — the login itself.

**What reads the output.** A server composes `new EnvDestinationStore(dir)` and
`new AbapSessionStore(dir)` (or the `XSUAA_*` pair) over the same directory and calls
`broker.getProvider(destination)` (auth-broker 5): the provider is seeded with the stored secret
when its binding matches the means exactly, and logs in afresh otherwise.

## The Subcommands

Every subcommand has its own help: `mcp-auth --help`, `mcp-auth oidc --help`, `mcp-auth
saml2-pure --help`, `mcp-auth saml2-bearer --help`. Every login runs on the broker's
`getProvider` / `getToken` with the choices the CLI states, in its own code: `renewal: () =>
refreshThenLogin()` (a person at a terminal can log in), `onWriteFailure: 'fail'` (no output
unless the secret landed), `authDebug: true` only with `--auth-debug`, and every collaborator the
grant needs, each ending with the run's interrupt.

### `mcp-auth` (`auth-code`): Authorization Code or Client Credentials

```bash
mcp-auth [auth-code] (--service-key <path> --output <path> | --env <path> [--output <path>] | --destination <name> [--destination-dir <dir>])
         [--type abap|xsuaa] [--credential] [--format env|json] [--service-url <url>]
         [--browser <name> | --browser-program <program>] [--redirect-port <port>]
         [--client-auth certificate --cert-path <path> --key-path <path> | --client-auth secret --basic-encoding raw|form]
         [--verbose] [--auth-debug]
```

- **The grant** is the command's — `authorization_code`, or `client_credentials` with
  `--credential` — written as `SAP_GRANT_TYPE`; it is never read from the service key.
- **The login** is the broker's UAA row (`getToken` with no provider of the CLI's own): an
  authorization code login carries `state` and an S256 PKCE challenge, and a callback without the
  `state` is refused.
- **`--redirect-port`** overrides the callback port; omitted, it is auth-providers' default
  (`61001`). If your redirect URI is registered with a specific port at the identity provider,
  pass it. The callback listens on loopback only: a remote user tunnels the port (`ssh -L`).
- **`--service-url`** is required for ABAP (the key's URL, else the flag) and optional for
  XSUAA. An XSUAA destination without a service URL is not reused by an `--env` rerun — it logs
  in again — except with `--client-auth`, on whose path the client identity alone decides.

```bash
# ABAP: authorization_code (default, opens the platform's default browser)
mcp-auth --service-key ./abap.json --output ./abap.env --type abap

# ABAP: the URL shown on stderr, no browser
mcp-auth --service-key ./abap.json --output ./abap.env --type abap --browser none

# XSUAA: authorization_code
mcp-auth auth-code --service-key ./mcp.json --output ./mcp.env --type xsuaa

# XSUAA: client_credentials
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa --credential

# XSUAA: a custom redirect port
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa --redirect-port 8080

# Reuse the session of an existing file, refreshed or logged in again only when needed
mcp-auth --env ./mcp.env --type xsuaa
```

### Client Authentication: `--client-auth`

How the service key's client authenticates to the authorization server is yours to state —
`mcp-auth` and `generate-env` read the same flags under the same rules, and neither infers it
from the key:

| Flags | The client authenticates with | Written to the destination |
|---|---|---|
| none | its client secret in the token request | `SAP_UAA_CLIENT_SECRET` |
| `--client-auth secret --basic-encoding raw\|form` | its client secret in an `Authorization: Basic` header (the broker's `fromServiceKeySecret`). `--basic-encoding` is required: `raw` for XSUAA (measured: it does not form-decode), `form` for UAA and Keycloak | `SAP_UAA_CLIENT_SECRET`, `SAP_UAA_BASIC_ENCODING` (this CLI's own line) |
| `--client-auth certificate --cert-path <path> --key-path <path>` | the key's x509 client: its certificate and private key, from **your** PEM files, presented at the key's `certurl` (`<certurl>/oauth/token`, the broker's `fromServiceKeyCertificate`) | `SAP_UAA_CLIENT_CERT_PATH`, `SAP_UAA_CLIENT_KEY_PATH` (absolute paths), `SAP_UAA_CERT_URL`; no client secret |

With `--type xsuaa` the names are `XSUAA_UAA_*`. The flag becomes the broker's
`clientAuthentication` strategy; the grant stays the command's. An `--env` run takes the file's
client authentication — its certificate paths, or the encoding it records — and refuses these
flags beside it.

```bash
# An x509 XSUAA key (created with {"credential-type": "x509"}): client_credentials with its
# certificate. client.crt / client.key are the key's certificate and key, saved by you.
mcp-auth --service-key ./x509-key.json --output ./mcp.env --type xsuaa --credential \
  --client-auth certificate --cert-path ./client.crt --key-path ./client.key

# A secret key, the secret in a Basic header as XSUAA reads it
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa --credential \
  --client-auth secret --basic-encoding raw
```

- **The PEM files are yours and stay where they are.** `--cert-path` and `--key-path` must name
  existing files; they are resolved to absolute paths before anything is written. The command
  never creates, copies or prints a certificate or a key — not in the destination, its work
  directory, `--format json`, or a failed run's output.
- **A service key carrying a certificate or a private key is never copied**, whatever the flags:
  it is read in place by `XsuaaServiceKeyStore`, the one store that answers a certificate client.
- **Refusals name the flag.** An x509 key (a certificate, no secret) without `--client-auth` is
  refused, naming the flags it needs; `--client-auth certificate` for a key without a certificate
  client is refused, naming `url, clientid, certificate, key, certurl`. A flag given without its
  choice, a choice without its flags, or a path with no file is refused before anything is read
  or written.
- **Measured:** `mcp-auth --credential --client-auth certificate` and `generate-env --grant
  client_credentials --client-auth certificate` against XSUAA on a BTP trial (2026-10-05, CLI
  2.1.0) — a token of the key's client, and a fresh broker over the written destination got one
  too. **Not measured:** `authorization_code` over x509, and ABAP environment service keys with
  x509.

### `mcp-auth oidc`: the OIDC Grants and the UAA Passcode

```bash
mcp-auth oidc --flow <browser|device|password|token_exchange> --output <path> [options]
```

- `--flow browser` — the OIDC authorization code grant with `state` and PKCE, through the
  loopback callback (`--browser`, `--redirect-port`). `--code <value>` hands over a code obtained
  elsewhere: no URL is built, so it carries neither `state` nor PKCE.
- `--flow device` — the device code: the verification URL and the code are always shown on
  stderr, whatever the log level.
- `--flow password` — `--username` and `--password`.
- `--flow password --passcode <code>` (or `--flow password` with neither `--password` nor
  `--username`, which asks for the code and shows the `<uaa>/passcode` page to fetch it from) —
  the UAA passcode grant, what `cf login --sso` does; it needs `--uaa-url` or `--service-key`.
- `--flow token_exchange` — `--subject-token` (and `--subject-token-type`, `--audience`,
  `--actor-token`, `--actor-token-type`, `--scope`).

The endpoints come from `--issuer` (discovered) or the explicit `--authorization-endpoint`,
`--device-authorization-endpoint`, `--token-endpoint`; the client from `--client-id` and
`--client-secret` (none: a public client). An OIDC destination stated with explicit endpoints and
a client is reused by auth-broker 5 after a restart as one stated with `--issuer` is.

```bash
mcp-auth oidc --flow browser --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
mcp-auth oidc --flow browser --token-endpoint https://issuer/token --client-id my-client --code <auth_code> --redirect-uri urn:ietf:wg:oauth:2.0:oob --output ./sso.env --type xsuaa
mcp-auth oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa
mcp-auth oidc --flow password --token-endpoint https://issuer/oauth/token --client-id my-client --username user --password pass --output ./sso.env --type xsuaa
mcp-auth oidc --flow password --uaa-url https://<subdomain>.authentication.<region>.hana.ondemand.com --client-id cf --passcode <code> --output ./sso.env --type xsuaa
mcp-auth oidc --flow token_exchange --issuer https://issuer --client-id my-client --subject-token <token> --output ./sso.env --type xsuaa

# A session file: its flow is the file's grant (--flow may be omitted, or must match)
mcp-auth oidc --env ./sso.env --type xsuaa
```

### `mcp-auth saml2-pure` and `mcp-auth saml2-bearer`: SAML

```bash
mcp-auth saml2-pure --idp-sso-url <url> --sp-entity-id <id> (--idp-metadata <url|path> | --idp-cert <path> --idp-entity-id <id>) --output <path> [options]
mcp-auth saml2-bearer (--service-key <path> | --uaa-url <url> --client-id <id>) (--idp-metadata <url|path> | --idp-cert <path> --idp-entity-id <id>) --output <path> [options]
```

**Every assertion is validated before it is used** — signature, issuer, audience, recipient, time
window, request ID and replay — by `@mcp-abap-adt/auth-providers` 6. The run writes the trust
into the destination (`SAP_SAML_IDP_CERTIFICATES_B64`, `SAP_SAML_IDP_ENTITY_ID`), and the broker
builds the validator from it: `saml2-bearer` gets the one that requires the `Assertion` signed
(the token endpoint is sent the Assertion alone), `saml2-pure` the one that requires the
`Response` signed; both refuse an assertion seen before in the same process. Without the trust
nothing is written, and the CLI invents none of it:

| Option | `--config` field | What it is |
|---|---|---|
| `--idp-cert <path>` (repeatable) | `idpCertificates` (string or list, inline PEM or base64 DER) | The identity provider's signing certificate(s), PEM (one or several) or binary DER. Repeat it to trust both keys during a rotation; on the command line it replaces the file's `idpCertificates`. |
| `--idp-entity-id <id>` | `idpEntityId` | The identity provider's `entityID` — the `Issuer` its assertions carry. |
| `--idp-metadata <url\|path>` | `idpMetadata` | The identity provider's SAML metadata (SAP Cloud Identity Services: `https://<tenant>.accounts.ondemand.com/saml2/metadata`), read by an XML parser. Fills the two rows above and `--idp-sso-url` where not given: signing keys and keys without `use`, never encryption keys. An https URL or a file; plain http only for loopback; every redirect checked hop by hop (at most five). Federation metadata works too: `--idp-entity-id` names the identity provider when there are several. |
| `--sp-entity-id <id>` | `spEntityId` | The `Audience` the assertion must name. For bearer against UAA/XSUAA, the `entityID` of their SAML metadata. |
| `--acs-url <url>` | `acsUrl` | The `Recipient` the assertion must name — the ACS the identity provider posts to. |
| `--idp-initiated` | `idpInitiated` | The identity provider starts the login: no AuthnRequest is sent, and the assertion must carry no `InResponseTo`. |
| `--authn-request-id <id>` | `authnRequestId` | **Refused**: a destination has no field for a request ID. Use `--idp-initiated`, or let the run send the request. |

**How the assertion is obtained** (`--assertion-flow`):

- **`browser`** (the default): the run sends the AuthnRequest and receives the SAMLResponse on a
  loopback ACS (`--browser`, `--redirect-port`).
- **`manual`**: you lift the `SAMLResponse` from the POST body and paste it. **A pasted login
  always declares its ACS** — from `--acs-url`, the SP metadata (`--saml-metadata`, or
  `<uaa.url>/saml/metadata` with `--service-key`), or `acsUrl` in `--config`; with none of them
  the run is a usage error naming `--acs-url`, before the destination is written or a login
  starts. There is no `localhost` fallback.
- **`--assertion <base64>`**: a SAMLResponse obtained elsewhere; it needs `--idp-initiated`.
- **`--idp-initiated`** — required for `saml2-bearer` against UAA or XSUAA, whose bearer grant
  refuses an assertion carrying `InResponseTo`: with `--assertion`, or with `--assertion-flow
  manual` (its default here), which asks you to start the login at the identity provider and
  paste the `SAMLResponse` it posts. `--idp-initiated` with `--assertion-flow browser` is
  refused: there is no request URL to open.

`saml2-pure` turns the validated SAMLResponse into the system's session cookies: you paste the
cookies the system set (or, with `--assertion-flow assertion`, the response itself is presented).
`--cookie "<cookies>"` hands over cookies you already hold: no login, stored as `saml` / `none`.

**XSUAA's side of a bearer run.** `--sp-entity-id`, `--acs-url` and the bearer token endpoint are
not in an XSUAA service key, but XSUAA publishes all three in its SAML metadata: its `entityID`
is the `Audience`, and its `/oauth/token/alias/<alias>` endpoint is both the `Recipient` and
where the assertion is exchanged. With `--service-key`, `saml2-bearer` reads
`<uaa.url>/saml/metadata` and fills whichever was not given; without network access to it, pass
the file (*Security > Trust Configuration > Download SAML Metadata* in the subaccount) as
`--saml-metadata`.

```bash
# Bearer against XSUAA with a service key: XSUAA's side from its metadata, the IdP's from its own
mcp-auth saml2-bearer --service-key ./service-key.json --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated --output ./sso.env --type xsuaa

# The same, every value stated, the assertion obtained elsewhere
mcp-auth saml2-bearer --idp-sso-url https://idp/sso --sp-entity-id <uaa-entity-id> --acs-url <uaa-bearer-acs> --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --idp-initiated --uaa-url https://uaa.example --client-id <client> --token-endpoint https://uaa.example/oauth/token/alias/<alias> --assertion <base64> --output ./sso.env --type xsuaa

# Pure SAML: SP-initiated browser login, the cookies the system sets pasted
mcp-auth saml2-pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --service-url https://my-abap.example --output ./saml.env --type abap

# Pure SAML, pasted: the ACS declared
mcp-auth saml2-pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --acs-url https://my-abap.example/sap/saml2/sp/acs/100 --assertion-flow manual --service-url https://my-abap.example --output ./saml.env --type abap

# Session cookies you already hold: stored as they are (saml / none), no login
mcp-auth saml2-pure --cookie "SAP_SESSIONID_XYZ_100=..." --service-url https://my-abap.example --output ./saml.env --type abap

# New cookies for the destination of an existing cookie session file
mcp-auth saml2-pure --env ./saml.env --cookie "SAP_SESSIONID_XYZ_100=..." --type abap
```

### A `--config` File

`oidc`, `saml2-pure` and `saml2-bearer` take `--config <file>`: a JSON file with the run's
provider config instead of (or beside) the flags. Its `protocol` and `flow` must name the
subcommand it is given to — `oidc` with any OIDC flow for `mcp-auth oidc`, `saml2` with `pure`
for `saml2-pure`, `saml2` with `bearer` for `saml2-bearer`; a file naming another subcommand, or
naming none, is a usage error naming `--config`. A flag overrides the same field in the file; a
`browser` field is mapped like `--browser` (an unknown value refused naming `browser`). A file
that sets a function-valued field (`authorizationCodeProvider`, `assertionProvider`,
`manualInput`) is refused naming the flag to use instead. A file that does not parse as JSON is
refused in fixed words, never quoting its bytes.

```json
{
  "protocol": "oidc",
  "flow": "device",
  "issuerUrl": "https://issuer",
  "clientId": "my-client",
  "scopes": ["openid", "profile"]
}
```

```json
{
  "protocol": "saml2",
  "flow": "bearer",
  "idpSsoUrl": "https://idp.example/sso",
  "spEntityId": "https://uaa.example/entity",
  "acsUrl": "https://uaa.example/oauth/token/alias/example",
  "idpEntityId": "https://idp.example/metadata",
  "idpCertificates": ["MIIC...base64 DER from the IdP metadata's <X509Certificate>..."],
  "idpInitiated": true,
  "assertionFlow": "manual"
}
```

```bash
mcp-auth oidc --config ./device.json --output ./sso.env --type xsuaa
mcp-auth saml2-bearer --config ./bearer.json --uaa-url https://uaa.example --client-id <client> --output ./sso.env --type xsuaa
```

## Browsers: `--browser` and `--browser-program`

Every flow that opens a browser — `mcp-auth` (authorization code), `mcp-auth oidc --flow
browser`, `saml2-pure` and `saml2-bearer` with `--assertion-flow browser`, a `--config` file's
`browser` field, and `generate-env` — maps `--browser` to a launcher of
`@mcp-abap-adt/auth-providers` by `process.platform`, in one table of the CLI's own:

| `--browser` | `linux` | `darwin` | `win32` |
|---|---|---|---|
| `auto` (default), `system` | `linuxDefaultBrowser()` (`xdg-open`) | `macDefaultBrowser()` | `windowsDefaultBrowser()` |
| `chrome` | `linuxBrowser('google-chrome')` | `macBrowser('Google Chrome')` | `windowsBrowser('chrome')` |
| `edge` | `linuxBrowser('microsoft-edge')` | `macBrowser('Microsoft Edge')` | `windowsBrowser('msedge')` |
| `firefox` | `linuxBrowser('firefox')` | `macBrowser('Firefox')` | `windowsBrowser('firefox')` |
| `none`, `headless` | no browser: the URL is shown on stderr | the same | the same |

- **`--browser-program <program>`** runs the program you name, as given — on Linux an executable
  on `PATH` or an absolute path (`google-chrome-stable`, `chromium`), on macOS an application
  name, on Windows a program name or path. It excludes `--browser`.
- **Any other platform** (`freebsd`, `aix`, …): a named browser or `--browser-program` is a
  usage error naming the flag (`--browser <name> has no launcher on this platform; use --browser
  none`), before anything is read or written. `none` / `headless` work everywhere. Nothing is
  guessed.
- **A launch that fails does not end the login**: the URL is shown on stderr and the callback
  keeps waiting.

```bash
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa --browser firefox
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa --browser-program chromium
```

## A Login Ends Only When You End It

There is no login time limit. A login waits until it finishes, an explicit error ends it, or you
end it:

- **Ctrl+C (`SIGINT`) or `SIGTERM`** aborts the run's one signal, which every wait of the run
  takes — the broker's calls, the strategies, the pasted input, `flush()`. The login ends
  `aborted`; the callback port is released before the run settles; the command prints `❌ the
  authorization was aborted` on stderr, removes its work directory, writes no output and exits
  `130` (`SIGINT`) or `143` (`SIGTERM`), with no stack trace.
- **A second signal** exits at once with its code, the work directory removed — your own bound,
  should a strategy not settle. **`SIGHUP`** exits `129` at once.
- The subcommands run in `mcp-auth`'s own process, so a signal to it ends whatever login it runs.
- A pasted value read from a closed stdin is a refusal, not a silent success.

## Logging, `--verbose` and `--auth-debug`

The CLI's logger writes every level to **stderr**, from `info` by default — so the providers'
prompt lines that go through a logger (where the callback waits, the SSH-tunnel hint, a URL that
cannot be shown) are seen. **`--verbose`** starts it from `debug`. **`--auth-debug`** sets the
broker's `authDebug: true` — the providers' one debug line for a refused token request then names
the request's secrets in their prepared form (never the server's text) — and implies
`--verbose`. **Nothing from the environment**: no variable (`DEBUG_SSO`, `DEBUG_AUTH_PROVIDERS`,
…) turns either on or changes the level. Without `--auth-debug` no line the CLI or a provider
writes carries a secret or server text.

**Failures, as printed.** One way for every run, never the `message` of a foreign value and never
a stack: an auth failure prints `❌ <reason>` or `❌ <reason> — <hint>`, then its diagnostics on a
line of their own; a broker `DestinationConfigError` prints its message (names only), then the
carried failure's hint and diagnostics; the CLI's own usage errors print their fixed words (an
I/O failure of its own names the flag and the path you gave, with a system code such as
`ENOENT`); anything else prints auth-errors' generic words for an unfamiliar error. A session
write that did not land prints `❌ The session was not stored: "<destination>": <reason>`.

## The `generate-env` Script

Generate a session file from a service key — a development script run with `tsx`, not one of the
package's commands (it is not compiled into `dist/`). From the repository root, after `npm run
build`:

```bash
npm run generate-env -w @mcp-abap-adt/auth-broker-cli -- <destination> [service-key-path] [session-path] --grant <authorization_code|client_credentials> \
  [--browser <name> | --browser-program <program>] [--verbose] [--auth-debug] \
  [--client-auth certificate --cert-path <path> --key-path <path> | --client-auth secret --basic-encoding raw|form]
```

- **Every run logs in** and reads no session, not even the file it writes — `--service-key`'s
  semantics.
- **`--grant` is required**: a service key holds a client, and a client may serve several grants,
  so the script never reads the grant from the key.
- `--browser` (default `auto`) and `--browser-program` are `mcp-auth`'s; `--client-auth`,
  `--basic-encoding`, `--cert-path` and `--key-path` too, under the same rules.
- It writes the means (`jwt`, the grant, the key's client and URL) through the destination store
  and the secret through the broker, on a copy in a private temporary directory: the session
  file is replaced only once the secret is stored. A refused or interrupted login exits non-zero
  and leaves the file byte for byte as it was. `SIGINT` / `SIGTERM` end it as they end `mcp-auth`.
- npm runs a workspace's script in that workspace's directory, so relative paths and the default
  `<destination>.json` / `<destination>.env` resolve against `packages/auth-broker-cli`; pass
  absolute paths to write elsewhere.

## Migrating to 3.0.0

What a CLI 2.x user must now do, row by row. The full list of changes is the
[CHANGELOG](CHANGELOG.md)'s 3.0.0 entry.

| 2.x | 3.0.0 — what to do |
|---|---|
| a login ended after five minutes | it waits until it finishes; end it with Ctrl+C (exit 130) or `SIGTERM` (exit 143); the port is released |
| `--browser chrome\|edge\|firefox\|system\|auto` | the same names, mapped to the platform's launcher (table above); on an unlisted platform use `none`; `--browser-program` names another program. Linux no longer gets `DISPLAY=:0` or a list of candidate Chrome executables — pass `--browser-program google-chrome-stable` (or `chromium`) where `google-chrome` is not installed |
| manual SAML without `--acs-url` used `http://localhost:<port>/callback` | state the ACS: `--acs-url`, `--saml-metadata`, `--service-key`'s metadata, or `acsUrl` in `--config` |
| progress and prompts on stdout | on stderr; stdout carries only `help` and `--version` |
| "🔗 Authorization URL: …" preview of `mcp-auth` | gone; the URL is shown by the login's own prompt (stderr) |
| `DEBUG_SSO=true` etc. for the `mcp-sso` log | `--verbose`; `--auth-debug` for the providers' debug line, with prepared secrets |
| error output: a message and a stack trace | `reason — hint`, then the diagnostics line; no stack trace |
| `--env <path>` beside `--service-key`: the refresh token tried first, else a login | `--env <path>` alone: the session file (it holds the means too) — a valid token reused, an expired one refreshed, else a login, written back to the file. `--service-key` alone now always logs in and writes a new pair. New: `--destination <name>` for the destination folder. Two sources together are a usage error |
| a means flag (`--credential`, `--service-url`, `--client-auth`, …) beside `--env` restated the means | refused: the file is used as it is, its client authentication included; run with `--service-key` to state new means |
| `mcp-sso … --cookie` sessions written by 2.x | refused naming `issuedBy` by auth-broker 5: run `mcp-auth saml2-pure … --cookie` again |
| sessions written by 2.x (any grant) | read as unbound once by auth-broker 5: the first run (or the server's first use) of each token destination logs in once |
| the `mcp-sso` command | **gone in 3.0.0**: every form is an `mcp-auth` subcommand with the same flags (table below) |
| `mcp-auth oidc` / `saml2-pure` / `saml2-bearer` started a second process (`mcp-sso`) | they run in `mcp-auth`'s process; a signal to it ends the login, frees the port and removes the work directory |
| `mcp-auth saml2-bearer` required `--dev` | it does not, and `--dev` is removed: drop it from the command line (it is refused as an unknown option) |
| `generate-env` opened the system browser | `--browser` (default `auto`) and `--browser-program`, as `mcp-auth` |

**`mcp-sso` → `mcp-auth`:**

| 2.x | 3.0.0 |
|---|---|
| `mcp-sso oidc --flow <browser\|device\|password\|token_exchange> …` | `mcp-auth oidc --flow <…> …` |
| `mcp-sso --protocol oidc --flow <flow> …` | `mcp-auth oidc --flow <flow> …` |
| `mcp-sso oidc … --passcode <p>` (the UAA passcode grant) | `mcp-auth oidc … --passcode <p>` |
| `mcp-sso oidc --flow browser … --code <c>` | `mcp-auth oidc --flow browser … --code <c>` |
| `mcp-sso saml2 --flow pure …` / `--protocol saml2 --flow pure …` | `mcp-auth saml2-pure …` |
| `mcp-sso saml2 --flow pure … --cookie "<cookies>"` | `mcp-auth saml2-pure … --cookie "<cookies>"` |
| `mcp-sso bearer …` / `saml2 --flow bearer …` / `--protocol saml2 --flow bearer …` | `mcp-auth saml2-bearer …` |
| `mcp-sso --config <file> …` (protocol and flow in the file) | `mcp-auth <the subcommand the file names> --config <file> …` |
| `mcp-sso --version`, `help` | `mcp-auth --version`, `mcp-auth <subcommand> --help` |
| a callback reachable from another machine | loopback only (auth-providers 6): tunnel the port (`ssh -L`) |

`--protocol` is not accepted: the subcommand is the protocol and flow. Migrations from earlier
majors (1.0.0 → 2.0.0, 2.0.0 → 2.1.0, the SAML trust needed since auth-providers 4) are in the
[CHANGELOG](CHANGELOG.md).

## Testing

The unit tests are in `src/__tests__/` (Jest). From the repository root — never `npx jest`
directly:

```bash
npm test -w @mcp-abap-adt/auth-broker-cli
```

They need no system and no configuration: each run goes in-process against a local token
endpoint, in a temporary directory, with a test double for every interactive step — no browser
opens. They read back what each run wrote through the two stores, check that no session write
carries means or the client secret, build a provider from the output with `getProvider`, deliver
`SIGINT` / `SIGTERM` during each kind of login and bind the callback port afterwards, and run the
built bin to check what reaches stdout and stderr.

The x509 live check — `mcp-auth` and `generate-env` with `--client-auth certificate` against
XSUAA on a BTP subaccount, `npm run test:live:x509`, not in CI — is described in the library's
README, [*The x509 Live Check*](../auth-broker/README.md#the-x509-live-check). The bin smoke
check — pack both packages, install the tarballs into an empty directory, run `mcp-auth` with
`--version` and every subcommand's `--help`, and check no `mcp-sso` is installed — is `npm run
check:packed` at the root, part of `npm run check`.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`). Copyright ©
2025–2026 Oleksii Kyslytsia. [`LICENSE`](LICENSE) is the LGPL,
[`COPYING`](COPYING) the GPL it is written on top of; both ship with the
package.
