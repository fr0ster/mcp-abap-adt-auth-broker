# Keycloak (Local) for mcp-sso Testing

This setup provides a local OIDC issuer for `mcp-sso` browser/password/device flows,
plus a basic SAML IdP client for generating SAML assertions (pure SAML tests).

## Start

Every command below runs from `packages/auth-broker-cli` (the CLI package),
after `npm run build` at the repository root.

```bash
cd tests/keycloak
docker compose up -d
```

Keycloak URL: `http://localhost:8080`
Admin login: `admin` / `admin`

## Realm

- Realm: `mcp-sso`
- Client: `mcp-sso-cli` (public, auth code + password + device grant)
- SAML Client: `mcp-sso-saml` (IdP -> local ACS)
- User: `demo` / `demo`

## mcp-sso Examples

```bash
# OIDC browser flow (authorization code via local callback on :3001)
node dist/mcp-sso.js \
  --protocol oidc \
  --flow browser \
  --issuer http://localhost:8080/realms/mcp-sso \
  --client-id mcp-sso-cli \
  --scopes openid,profile,email \
  --output /tmp/keycloak.env \
  --type xsuaa

# OIDC password flow (direct access grant)
node dist/mcp-sso.js \
  --protocol oidc \
  --flow password \
  --token-endpoint http://localhost:8080/realms/mcp-sso/protocol/openid-connect/token \
  --client-id mcp-sso-cli \
  --username demo \
  --password demo \
  --output /tmp/keycloak.env \
  --type xsuaa

# OIDC device flow
node dist/mcp-sso.js \
  --protocol oidc \
  --flow device \
  --issuer http://localhost:8080/realms/mcp-sso \
  --client-id mcp-sso-cli \
  --scopes openid,profile,email \
  --output /tmp/keycloak.env \
  --type xsuaa
```

Notes:
- Browser flow expects the redirect URI `http://localhost:3001/callback`. This is already allowed in the realm config.
- If you change the redirect port in `mcp-sso`, update the realm redirect URIs accordingly.
- If device flow fails, verify in Keycloak Admin UI that **Device Authorization Grant** is enabled for `mcp-sso-cli`.

## SAML (Pure) Assertion Capture

Start a local ACS endpoint and capture SAMLResponse:

```bash
node tests/keycloak/saml-acs.js
```

Then open the SP-initiated URL printed by:

```
node tests/keycloak/saml-sp.js
```

After login, `saml-acs.js` will print `SAMLResponse` (base64). Use it with:

```bash
node dist/mcp-sso.js \
  --protocol saml2 \
  --flow pure \
  --idp-sso-url http://localhost:8080/realms/mcp-sso/protocol/saml \
  --sp-entity-id mcp-sso-saml \
  --acs-url http://localhost:3002/acs \
  --idp-metadata http://localhost:8080/realms/mcp-sso/protocol/saml/descriptor \
  --idp-initiated \
  --assertion <base64> \
  --assertion-flow assertion \
  --service-url http://localhost:4004 \
  --output /tmp/keycloak-saml.env \
  --type abap
```

`mcp-sso` writes the destination (`saml` / `saml2_pure`, the trust under `SAP_SAML_*`) and the
broker's provider validates the assertion. `--idp-metadata` reads the realm's signing certificate
and entityID from its SAML descriptor — the realm's key is generated when Keycloak imports the
realm, so it cannot be checked in. An assertion answering the SP-initiated request `saml-sp.js`
built cannot be used from 2.0.0: that needed `--authn-request-id`, which a destination cannot
state, so `mcp-sso` refuses it. `run-tests.sh` logs in IdP-initiated and passes `--idp-initiated`;
the realm names `http://localhost:3002/acs` as that login's ACS.

## Automated (No Manual Codes)

Run:
```bash
tests/keycloak/run-tests.sh
```

This runs:
- OIDC password flow with `demo/demo`
- SAML pure flow with auto login (no manual copy of assertion)

## Interactive (Single Entry)

Run:
```bash
tests/keycloak/run-interactive.sh
```

This runs:
- OIDC device flow
- SAML pure flow (browser login, no copy/paste)

## Interactive (Split)

Run OIDC:
```bash
tests/keycloak/run-oidc.sh
```

Run SAML:
```bash
tests/keycloak/run-saml.sh
```

Notes:
- OIDC device flow needs browser approval but no code paste.
- SAML flow requires browser login, but no copy/paste of assertion.
- `run-saml.sh` uses a simple SP-initiated AuthnRequest, answered with `--authn-request-id`,
  which `mcp-sso` 2.0.0 refuses (see above): it fails until a destination can state a request ID.
  `run-tests.sh` covers the SAML pure flow IdP-initiated, headless.
