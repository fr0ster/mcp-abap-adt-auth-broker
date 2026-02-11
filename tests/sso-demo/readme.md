# SSO Demo (CAP + XSUAA)

Minimal CAP service for testing XSUAA auth flows used by `mcp-sso`.

## What’s Included

- CAP Node.js app with a simple OData service
- XSUAA config with enabled grant types (auth code + SAML bearer)
- MTA deployment files

## Service

`CatalogService` exposes:
- `Books` entity
- `echo(text)` action

All access requires the `User` role.

## Local Run (No Auth)

```bash
npm install
cds watch
```

This runs without XSUAA in local profile and is only for smoke tests.

## Cloud Foundry Deploy (Trial)

1. Login and target a CF space.
2. Install build tools (once):

```bash
npm install -g @sap/cds-dk mbt
```

3. Build and deploy:

```bash
cds build --production
mbt build -t gen
cf deploy gen/mta_archives/*.mtar
```

4. Create a service key (example):

```bash
npm run service-key:create
npm run service-key:fetch
```

Cleanup (optional):
```bash
npm run service-key:delete
```

Use the service key JSON for `mcp-auth` / `mcp-sso` tests.

This creates the XSUAA instance and deploys the app.

## XSUAA Grants

Configured in `xs-security.json`:
- `authorization_code`
- `refresh_token`
- `client_credentials`
- `password`
- `urn:ietf:params:oauth:grant-type:saml2-bearer`

If you need to adjust redirect URIs or grant types, update `xs-security.json`
and redeploy.
