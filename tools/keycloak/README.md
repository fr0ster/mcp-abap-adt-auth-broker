# Keycloak (Local) for mcp-sso Testing

This setup provides a local OIDC issuer for `mcp-sso` browser/password/device flows,
plus a basic SAML IdP client for generating SAML assertions (pure SAML tests).

## Start

```bash
cd tools/keycloak
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
node dist/bin/mcp-sso.js \
  --protocol oidc \
  --flow browser \
  --issuer http://localhost:8080/realms/mcp-sso \
  --client-id mcp-sso-cli \
  --scopes openid,profile,email \
  --output /tmp/keycloak.env \
  --type xsuaa

# OIDC password flow (direct access grant)
node dist/bin/mcp-sso.js \
  --protocol oidc \
  --flow password \
  --token-endpoint http://localhost:8080/realms/mcp-sso/protocol/openid-connect/token \
  --client-id mcp-sso-cli \
  --username demo \
  --password demo \
  --output /tmp/keycloak.env \
  --type xsuaa

# OIDC device flow
node dist/bin/mcp-sso.js \
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
node tools/keycloak/saml-acs.js
```

Then open the IdP SSO URL in a browser:

```
http://localhost:8080/realms/mcp-sso/protocol/saml/clients/mcp-sso-saml
```

After login, `saml-acs.js` will print `SAMLResponse` (base64). Use it with:

```bash
node dist/bin/mcp-sso.js \
  --protocol saml2 \
  --flow pure \
  --idp-sso-url http://localhost:8080/realms/mcp-sso/protocol/saml \
  --sp-entity-id mcp-sso-saml \
  --assertion <base64> \
  --output /tmp/keycloak-saml.env \
  --type abap
```

## Automated (No Manual Codes)

Run:
```bash
tools/keycloak/run-tests.sh
```

This runs:
- OIDC password flow with `demo/demo`
- SAML pure flow with auto login (no manual copy of assertion)
