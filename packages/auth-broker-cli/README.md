# @mcp-abap-adt/auth-broker-cli
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

The `mcp-auth` and `mcp-sso` commands: log in to a SAP BTP or ABAP destination
and write its session file, through
[`@mcp-abap-adt/auth-broker`](../auth-broker/README.md).

- `mcp-auth` — service key → session: authorization code or client
  credentials; `saml2-pure` / `saml2-bearer` are handed to `mcp-sso`.
- `mcp-sso` — OIDC (browser, device, password, token exchange) and SAML
  (bearer, pure) single sign-on.

Up to `@mcp-abap-adt/auth-broker` 3.0.4 these commands shipped in the library
package; its CHANGELOG holds their history. This package carries them from
1.0.0 on, with the same commands and flags.

## Installation

**Not published yet.** 1.0.0 is released together with
`@mcp-abap-adt/auth-broker` 4.0.0. Until then the published commands are in the
library:

```bash
npm install -g @mcp-abap-adt/auth-broker@3.0.4
```

Once 1.0.0 is on npm:

```bash
npm install -g @mcp-abap-adt/auth-broker-cli
```

Requires Node.js 22, 24 or 26 (`engines: "^22 || ^24 || ^26"`).

## Commands

### CLI: mcp-auth

Generate or refresh `.env`/JSON output using AuthBroker + stores:

```bash
mcp-auth <auth-code|oidc|saml2-pure|saml2-bearer> [options]
mcp-auth --service-key <path> --output <path> [--env <path>] [--type abap|xsuaa] [--credential] [--browser auto|none|system|chrome|edge|firefox] [--format json|env]
```

**Note**: The CLI is compiled to `dist/` and does not require `tsx` at runtime. From a clone, run `npm install` and `npm run build` at the repository root; the commands are then `packages/auth-broker-cli/dist/mcp-auth.js` and `…/mcp-sso.js`.

**Authentication Flow:**
- Default: `authorization_code` (browser-based OAuth2)
- `--credential`: `client_credentials` (clientId/clientSecret, no browser)

**Browser Options (for authorization_code):**
- `auto` (default): Try to open browser, fallback to showing URL
- `none`: Show URL in console and wait for callback (no browser)
- `system/chrome/edge/firefox`: Open specific browser

`--browser` and `--redirect-port` are routed into `browserCallbackStrategy`. This CLI has no
default of its own for the callback port: `--redirect-port` overrides it when given; omitted,
the port comes from `auth-providers` (currently `61001`, chosen to sit above the ephemeral range
and clear of the `3001`/`3333` range servers and proxies typically use). If you registered a
redirect URI with a specific port at your identity provider, pass `--redirect-port` to match it.
A login is given 5 minutes to complete (this is a person switching to a browser and signing in
by hand, not an unattended caller).

**SAML options (`saml2-pure`, `saml2-bearer`):**
`mcp-auth` hands these subcommands to `mcp-sso` with every argument unchanged, so the SAML options
are `mcp-sso`'s (see *CLI: mcp-sso* and *SAML assertion validation* below) and its exit code is
`mcp-auth`'s. The ones a run needs:

| Option | What it is |
|---|---|
| `--idp-metadata <url\|path>` | The identity provider's SAML metadata; fills `--idp-cert`, `--idp-entity-id` and `--idp-sso-url`. For SAP Cloud Identity Services: `https://<tenant>.accounts.ondemand.com/saml2/metadata`. |
| `--idp-cert <path>`, `--idp-entity-id <id>` | The same trust, stated instead of read. |
| `--idp-initiated` | The identity provider starts the login. `saml2-bearer` against XSUAA needs it. |
| `--sp-entity-id`, `--acs-url` | The `Audience` and `Recipient`. For `saml2-bearer` with `--service-key`, read from `<uaa.url>/saml/metadata`. |
| `--assertion <base64>`, `--assertion-flow <flow>` | A `SAMLResponse` obtained elsewhere, or how to obtain one. |
| `--authn-request-id <id>` | The request an `--assertion` answers, when `mcp-sso` did not send it. |

`saml2-bearer` still requires `--dev`: it has not been run against a live XSUAA with a SAML trust.

**Examples:**
```bash
# Auth code (default via service key)
mcp-auth auth-code --service-key ./abap.json --output ./abap.env --type abap

# OIDC SSO (device flow example)
mcp-auth oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa

# SAML2 pure (cookie); the SAML flags are mcp-sso's, see "SAML assertion validation" below
mcp-auth saml2-pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --output ./saml.env --type abap

# SAML2 bearer (in progress, requires --dev)
mcp-auth saml2-bearer --dev --service-key ./mcp.json --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated --output ./sso.env --type xsuaa

# ABAP: authorization_code (default, opens browser)
mcp-auth --service-key ./abap.json --output ./abap.env --type abap

# ABAP: authorization_code (show URL in console, no browser)
mcp-auth --service-key ./abap.json --output ./abap.env --type abap --browser none

# XSUAA: authorization_code (default)
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa

# XSUAA: client_credentials (special cases)
mcp-auth --service-key ./mcp.json --output ./mcp.env --type xsuaa --credential

# Using existing .env for refresh token
mcp-auth --env ./mcp.env --service-key ./mcp.json --output ./mcp.env --type xsuaa
```

### CLI: mcp-sso

Get tokens via SSO providers (OIDC/SAML) and generate `.env`/JSON output:

```bash
mcp-sso <oidc|saml2|bearer> [options]
mcp-sso --protocol <oidc|saml2> --flow <flow> --output <path> [--type abap|xsuaa] [--format env|json] [--env <path>] [--config <path>]
```

**Supported flows:**
- OIDC: `browser`, `device`, `password`, `token_exchange`
- SAML2: `bearer`, `pure`

Only the flows that actually open a browser (OIDC `browser`; SAML2 `bearer`/`pure` with the
default `--assertion-flow browser`) use `--browser` and `--redirect-port` — they are routed
into `browserCallbackStrategy`/`oidcCallbackStrategy`/`samlCallbackStrategy`. This CLI has no
default of its own for the callback port: `--redirect-port` overrides it when given; omitted,
the port comes from `auth-providers` (currently `61001`). A login is given 5 minutes to
complete. `device`, `password`, and `token_exchange` never open a browser from this process, so
`--browser`/`--redirect-port` have no effect for them. This applies the same way whether
`--protocol`/`--flow` come from CLI flags or from `--config` (below) — a field's origin doesn't
change how it's handled, and CLI flags always take precedence over the same field in a file.

**Examples:**
```bash
# OIDC browser flow
mcp-sso oidc --flow browser --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa

# OIDC browser flow (manual code / OOB — no callback server is opened for this combination)
mcp-sso oidc --flow browser --token-endpoint https://issuer/token --client-id my-client --code <auth_code> --redirect-uri urn:ietf:wg:oauth:2.0:oob --output ./sso.env --type xsuaa

# OIDC device flow
mcp-sso oidc --flow device --issuer https://issuer --client-id my-client --output ./sso.env --type xsuaa

# OIDC password flow
mcp-sso oidc --flow password --token-endpoint https://issuer/oauth/token --client-id my-client --username user --password pass --output ./sso.env --type xsuaa

# OIDC token exchange
mcp-sso oidc --flow token_exchange --issuer https://issuer --client-id my-client --subject-token <token> --output ./sso.env --type xsuaa

# SAML bearer flow against XSUAA with a service key: the Audience, Recipient and token alias
# come from <uaa.url>/saml/metadata, the IdP's trust from its own metadata
mcp-sso bearer --service-key ./service-key.json --idp-metadata https://<ias-tenant>.accounts.ondemand.com/saml2/metadata --idp-initiated --output ./sso.env --type xsuaa

# The same, every value stated (IdP-initiated assertion -> token)
mcp-sso bearer --idp-sso-url https://idp/sso --sp-entity-id <uaa-entity-id> --acs-url <uaa-bearer-acs> --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --idp-initiated --token-endpoint https://uaa.example/oauth/token --assertion <base64> --output ./sso.env --type xsuaa

# SAML pure flow (cookie; SP-initiated browser login, the request is sent by mcp-sso)
mcp-sso saml2 --flow pure --idp-sso-url https://idp/sso --sp-entity-id my-sp --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --cookie "SAP_SESSION=..." --output ./sso.env --type abap
```

**SAML assertion validation:**
Both SAML flows validate every assertion before using it — signature, issuer, audience,
recipient, time window, request ID and replay (done by `@mcp-abap-adt/auth-providers` 4; see its
README, *SAML assertion validation*). The provider will not even be constructed without the
trust it checks against, and `mcp-sso` invents none of it — it is stated, or read from SAML
metadata:

| Option | `--config` field | What it is |
|---|---|---|
| `--idp-cert <path>` (repeatable) | `idpCertificates` (string or list, inline PEM or base64 DER) | The identity provider's signing certificate(s). A file may be PEM (one or several certificates) or binary DER. Repeat the flag, or list several, to trust both keys during a rotation. |
| `--idp-entity-id <id>` | `idpEntityId` | The identity provider's `entityID` — the `Issuer` its assertions carry. |
| `--idp-metadata <url\|path>` | `idpMetadata` | The identity provider's SAML metadata (for SAP Cloud Identity Services `https://<tenant>.accounts.ondemand.com/saml2/metadata`). Fills the two rows above and `--idp-sso-url` where not given: signing keys and keys without `use`, never encryption keys. An https URL or a file; plain http only for loopback. Federation metadata (an `EntitiesDescriptor` of several entities) works too: entity ID, keys and SSO URL all come from the same identity provider, which `--idp-entity-id` names when there are several — without it such a run stops and lists them. |
| `--sp-entity-id <id>` | `spEntityId` | Already required; it is now also the `Audience` the assertion must name. For bearer against UAA/XSUAA, the `entityID` in their SAML metadata. |
| `--acs-url <url>` | `acsUrl` | The `Recipient` the assertion must name. For bearer against UAA/XSUAA, the token endpoint's bearer ACS; the default `http://localhost:<port>/callback` fits only a login delivered to this CLI. |
| `--idp-initiated` | `idpInitiated` (`true`/`false`) | The identity provider starts the login and no AuthnRequest is sent, so the assertion must carry no `InResponseTo`. |
| `--authn-request-id <id>` | `authnRequestId` | The AuthnRequest ID an `--assertion` answers, when the request was sent by something other than `mcp-sso`. |

A `--idp-cert` on the command line replaces the file's `idpCertificates` rather than adding to
them, so a certificate retired on the command line is not still trusted from the file.

Which request setting a run needs:

- **Browser or manual login, SP-initiated** (`--assertion-flow browser`, the default, or
  `manual`): nothing — `mcp-sso` builds the AuthnRequest and knows its ID.
- **`--assertion <base64>`** from an SP-initiated login sent elsewhere: `--authn-request-id`.
- **IdP-initiated** — required for `bearer` against UAA or XSUAA, whose saml2-bearer grant refuses
  an assertion carrying `InResponseTo`: `--idp-initiated`, with `--assertion`, or with
  `--assertion-flow manual` (the default under `--idp-initiated`), which asks you to start the
  login at the identity provider and paste the `SAMLResponse` it posts. `--idp-initiated` with
  `--assertion-flow browser` is refused, since there is no request URL to open.

`--idp-initiated` together with `--authn-request-id`, a missing certificate or entity ID, or an
assertion that fails a check is reported by `auth-providers` itself (`ValidationError` or
`AssertionValidationError`), with the field or the check it refused.

**XSUAA's side of a bearer run:**
None of `--sp-entity-id`, `--acs-url` and the bearer token endpoint is in an XSUAA service key, but
XSUAA publishes all three in its SAML metadata: its `entityID` is the `Audience`, and its
`/oauth/token/alias/<alias>` endpoint is both the `Recipient` and where the assertion is exchanged.
With `--service-key`, `bearer` reads `<uaa.url>/saml/metadata` and fills whichever of them was not
given. Without network access to it, pass the file (from *Security > Trust Configuration >
Download SAML Metadata* in the subaccount):

```bash
mcp-sso bearer --saml-metadata ./saml-sp.xml --idp-sso-url https://idp/sso --sp-entity-id <uaa-entity-id> --acs-url <uaa-bearer-acs> --idp-cert ./idp-signing.pem --idp-entity-id https://idp.example/metadata --idp-initiated --assertion <base64> --service-key ./service-key.json --output ./sso.env --type xsuaa
```

### Local Keycloak (OIDC + SAML Tests)

For local testing of `mcp-sso`, a ready-to-run Keycloak setup is included
(OIDC browser/password/device + SAML assertion capture).

From `packages/auth-broker-cli`, after `npm run build` at the repository root:

```bash
cd tests/keycloak
docker compose up -d
```

Then use:
```bash
node dist/mcp-sso.js \
  oidc \
  --flow browser \
  --issuer http://localhost:8080/realms/mcp-sso \
  --client-id mcp-sso-cli \
  --scopes openid,profile,email \
  --output /tmp/keycloak.env \
  --type xsuaa
```

See [`tests/keycloak/README.md`](tests/keycloak/README.md) for device flow and SAML examples.

### XSUAA Demo (CAP)

A minimal CAP app for testing XSUAA flows is included at `packages/auth-broker-cli/tests/sso-demo`.
It enables `authorization_code` and `saml2-bearer` grant types and provides a
simple `CatalogService`. See [`tests/sso-demo/readme.md`](tests/sso-demo/readme.md) for deploy steps.

**Config file:**
You can pass a JSON file with provider config instead of (or alongside) `--protocol`/`--flow`
and the OIDC/SAML flags — `--config` alone is enough to run a flow, with no other flags required:

```json
{
  "protocol": "oidc",
  "flow": "device",
  "issuerUrl": "https://issuer",
  "clientId": "my-client",
  "scopes": ["openid", "profile"]
}
```

Any CLI flag given alongside `--config` overrides the same field in the file; a field the file
sets and no flag overrides is used as-is. A file written for a pre-2.0.0 config still works:
`browser` and `redirectPort` are routed into the strategy exactly as the equivalent CLI flags
are, and `authorizationCode`/`assertionFlow` are honored the same way `--code`/`--assertion-flow`
are. A file that sets `authorizationCodeProvider`, `assertionProvider`, or `manualInput` — all
functions, which JSON cannot express — is refused with an error naming the CLI flag to use
instead, rather than having the field silently dropped.

A SAML config file carries the trust inline:

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

#### Migrating `mcp-sso` SAML runs from 2.2.0

2.2.0 used `@mcp-abap-adt/auth-providers` 2.x, which trusted any SAML payload it was handed.
With 4.x every `mcp-sso` SAML run (`bearer`, `saml2 --flow pure`, and `mcp-auth saml2-pure` /
`saml2-bearer`, which call it) fails before login until you add:

1. `--idp-metadata <url|path>`, or `--idp-cert <path>` and `--idp-entity-id <id>` (or
   `idpCertificates` and `idpEntityId` in `--config`) — without them the provider refuses to
   construct.
2. The real `--sp-entity-id` (the `Audience`) and, unless the assertion is delivered to this CLI's
   own callback, the `--acs-url` it names as `Recipient`. For `bearer` with `--service-key` both
   are read from XSUAA's metadata.
3. For `bearer` against UAA or XSUAA: `--idp-initiated`, with `--assertion` or
   `--assertion-flow manual`. For any other `--assertion` from an SP-initiated login:
   `--authn-request-id`.

Node.js 22, 24 or 26 is required.

### Utility Script

Generate `.env` files from service keys — a development script run with `tsx`,
not one of the package's commands (it is not compiled into `dist/`). From the
repository root, after `npm run build`:

```bash
npm run generate-env -w @mcp-abap-adt/auth-broker-cli -- <destination> [service-key-path] [session-path]
```

npm runs a workspace's script in that workspace's directory, so relative paths
and the default `<destination>.json` / `<destination>.env` resolve against
`packages/auth-broker-cli`; pass absolute paths to write elsewhere.

## Testing

The unit tests are in `src/__tests__/` (Jest). From the repository root:

```bash
npm test -w @mcp-abap-adt/auth-broker-cli
```

They need no system and no configuration. The stands above (`test:mcp-auth`,
`test:mcp-sso`, `test:device-code`, `test:saml-pure`, `test:sso`) are
interactive and run only by hand:
`npm run <script> -w @mcp-abap-adt/auth-broker-cli`.

The bin smoke check — pack both packages, install the tarballs into an empty
directory, run each command with `--version` and `help` — is
`npm run check:packed` at the root, part of `npm run check`.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`). Copyright ©
2025–2026 Oleksii Kyslytsia. [`LICENSE`](LICENSE) is the LGPL,
[`COPYING`](COPYING) the GPL it is written on top of; both ship with the
package.
