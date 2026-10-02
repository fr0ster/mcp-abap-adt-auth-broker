# Installation Guide

This guide explains how to install and set up the `@mcp-abap-adt/auth-broker` package (4.0.0)
and its commands, `@mcp-abap-adt/auth-broker-cli` (2.0.0). Upgrading from 3.x: see
*Migrating from 3.x* in the [library README](../../packages/auth-broker/README.md#migrating-from-3x).

## Prerequisites

- **Node.js**: Version 22, 24 or 26 (`engines: "^22 || ^24 || ^26"`; 22 and 24 are the versions SAP BTP Cloud Foundry offers)
- **npm**: Version 7.0.0 or higher (comes with Node.js)
- **SAP BTP Account**: For obtaining service keys (if using browser authentication)

## Installation

### NPM Installation

```bash
npm install @mcp-abap-adt/auth-broker @mcp-abap-adt/auth-stores @mcp-abap-adt/auth-providers
```

The library brings `@mcp-abap-adt/auth-providers` 5 as a dependency, but not
the stores: install `@mcp-abap-adt/auth-stores` 3 or later (or bring stores of
your own on the `@mcp-abap-adt/interfaces-auth-broker` contracts) — the
session store must take a write of the secret alone, which auth-stores 1.x and
2.x do not. Declare `@mcp-abap-adt/auth-providers` yourself when your code
imports it (strategies, presenters, a provider of your own).

The `mcp-auth` and `mcp-sso` commands are not part of this package from 3.1.0
on: they are `@mcp-abap-adt/auth-broker-cli`, in the same repository.

```bash
npm install -g @mcp-abap-adt/auth-broker-cli
```

Its 2.0.0, on the library's 4.0.0, writes a complete 4.0 destination
— the means through `EnvDestinationStore`, the secret through the broker — to
the file it always wrote, and `flush()`es before it writes the output (exit 1
when the secret is not stored); see its
[README](../../packages/auth-broker-cli/README.md#what-each-command-writes-and-where)
and *Migrating from 1.0.0* there.

If you installed `@mcp-abap-adt/auth-broker` globally for the commands (3.0.4
or earlier), swap it:

```bash
npm uninstall -g @mcp-abap-adt/auth-broker && npm i -g @mcp-abap-adt/auth-broker-cli
```

### Verify Installation

```bash
npm list @mcp-abap-adt/auth-broker
```

## Configuration

### Service Key Setup

1. **Obtain Service Key**: Get service key from SAP BTP Cockpit for your ABAP system
2. **Save Service Key**: Save as `{destination}.json` file

Example: `TRIAL.json`
```json
{
  "url": "https://your-system.abap.us10.hana.ondemand.com",
  "uaa": {
    "url": "https://your-account.authentication.us10.hana.ondemand.com",
    "clientid": "your_client_id",
    "clientsecret": "your_client_secret"
  }
}
```

A service key holds the client and the URL, never which grant the
destination uses: whoever builds the key store states it —
`new AbapServiceKeyStore(dir, { grantType: 'authorization_code' })`.

### Environment File Setup

A destination may also be stated in `{destination}.env` — what `mcp-auth` /
`mcp-sso` write, or a file you write yourself. With auth-stores 3 the file has
two roles: the means, read by `EnvDestinationStore`, and the secret, written
by the broker through a session store (`AbapSessionStore`); each touches only
its own keys.

Example: `TRIAL.env`
```env
# the means — you (or the CLI) write these; the broker never does
SAP_URL=https://your-system.abap.us10.hana.ondemand.com
SAP_CLIENT=100
SAP_AUTH_TYPE=jwt
SAP_GRANT_TYPE=authorization_code
SAP_UAA_URL=https://your-account.authentication.us10.hana.ondemand.com
SAP_UAA_CLIENT_ID=your_client_id
SAP_UAA_CLIENT_SECRET=your_client_secret
# the secret — the broker writes these after a login
SAP_JWT_TOKEN=...
SAP_EXPIRES_AT=...
SAP_REFRESH_TOKEN=...
SAP_ISSUED_FOR=...
SAP_ISSUED_BY=...
```

## File Locations

Where files live is the stores' concern (`@mcp-abap-adt/auth-stores`), not the
broker's: each store takes its directory in its constructor, with no default,
and the broker reads no environment variable for it.

```typescript
import {
  AbapServiceKeyStore,
  AbapSessionStore,
  EnvDestinationStore,
} from '@mcp-abap-adt/auth-stores';

// The means: <destinations>/<destination>.env, falling back to the SAP service key
const serviceKeyStore = new EnvDestinationStore('/path/to/destinations', {
  fallback: new AbapServiceKeyStore('/path/to/keys', { grantType: 'authorization_code' }),
});
// The secret: <sessions>/<destination>.env (the same directory as the means is fine)
const sessionStore = new AbapSessionStore('/path/to/sessions');
```

## Quick Start

1. **Install Packages**:
   ```bash
   npm install @mcp-abap-adt/auth-broker @mcp-abap-adt/auth-stores @mcp-abap-adt/auth-providers
   ```

2. **Create Service Key File**:
   ```bash
   # Save your service key as TRIAL.json
   cp /path/to/service-key.json ./TRIAL.json
   ```

3. **Use in Code**:
   ```typescript
   import { AuthBroker } from '@mcp-abap-adt/auth-broker';
   import { AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-stores';
   import {
     AuthorizationCodeProvider,
     browserCallbackStrategy,
   } from '@mcp-abap-adt/auth-providers';

   const broker = new AuthBroker({
     serviceKeyStore: new AbapServiceKeyStore(process.cwd()),
     sessionStore: new AbapSessionStore(process.cwd()),
     provider: (destination, authConfig, connConfig) =>
       new AuthorizationCodeProvider({
         uaaUrl: authConfig!.uaaUrl,
         clientId: authConfig!.uaaClientId,
         clientSecret: authConfig!.uaaClientSecret,
         refreshToken: authConfig!.refreshToken,
         accessToken: connConfig.authorizationToken,
         authorization: browserCallbackStrategy({ browser: 'system' }),
       }),
   });
   const token = await broker.getToken('TRIAL');
   ```

   Or let the destination state its provider, and give the broker no
   `provider`: the token API then asks the provider `getProvider` builds —
   the one a `@mcp-abap-adt/connection` 10 connector takes — and the two share
   one token:

   ```typescript
   const broker = new AuthBroker({
     serviceKeyStore: new AbapServiceKeyStore(process.cwd(), {
       grantType: 'authorization_code',
     }),
     sessionStore: new AbapSessionStore(process.cwd()),
     authorization: () => browserCallbackStrategy({ browser: 'system' }),
   });
   const token = await broker.getToken('TRIAL');
   const provider = await broker.getProvider('TRIAL'); // the same provider
   ```

4. **First Run**: On first run, the browser opens for the login. After it, the session store holds the secret — with `AbapSessionStore`, in `TRIAL.env` beside the key. Call `await broker.flush()` before the process exits to know it was stored.

## Security Considerations

### File Permissions

Ensure proper file permissions for sensitive files:

```bash
# Linux/macOS
chmod 600 TRIAL.json TRIAL.env

# Windows
icacls TRIAL.json /grant:r %USERNAME%:R
icacls TRIAL.env /grant:r %USERNAME%:R
```

### Version Control

**Never commit** the following files to version control:
- `*.env` files (contain tokens)
- `*.json` service key files (contain credentials)

Add to `.gitignore`:
```
*.env
*.json
!package.json
!package-lock.json
```

### Rotating Credentials

Rotate service keys regularly. A changed URL, SAP client, UAA or client costs
one fresh login: the stored secret is bound to the ones it was obtained for and
is not reused elsewhere.

## Troubleshooting

### File Not Found Errors

If you see "file not found" errors:

1. **Check File Location**: Verify files are in the expected directory
2. **Check Directories**: Review the directories given to each store's constructor
3. **Check File Names**: Ensure files are named `{destination}.env` and `{destination}.json`

### Browser Authentication Issues

If browser doesn't open:

1. **Check System Browser**: Verify default browser is configured
2. **Check the callback port is available**: The OAuth callback port comes from
   `@mcp-abap-adt/auth-providers` (currently `61001`) unless overridden — with the `mcp-auth`/
   `mcp-sso` CLIs, via `--redirect-port`. Ensure whichever port is actually in use is free.
3. **Check Firewall**: Ensure localhost connections are allowed

### `DestinationConfigError`

`getProvider` (and the token API) name what a destination lacks in
`missingFields` — a field of the key store (`authType`, `grantType`, `uaaUrl`,
…), a session field (`issuedFor`, `authorizationToken` for a `none`
destination), or a collaborator option (`authorization`, …). A 3.x `jwt` /
`saml` file that states no `SAP_GRANT_TYPE` is refused naming `grantType`.

### Token Refresh Issues

If token refresh fails:

1. **Check Refresh Token**: Verify refresh token is valid and not expired
2. **Check UAA Credentials**: Ensure service key has correct UAA configuration
3. **Check Network**: Verify connectivity to UAA server

## Next Steps

- See [Usage Guide](../using/USAGE.md) for API documentation and examples
- See [Architecture](../architecture/ARCHITECTURE.md) for technical details
- See [Testing](../development/TESTING.md) for development and testing guide

