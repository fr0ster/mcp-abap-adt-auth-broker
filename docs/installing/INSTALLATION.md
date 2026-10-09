# Installation Guide

This guide explains how to install and set up the `@mcp-abap-adt/auth-broker` package (5.0.0)
and its command, `@mcp-abap-adt/auth-broker-cli` (3.0.0). Upgrading from 4.x: *Migrating to
5.0.0* in the [library README](../../packages/auth-broker/README.md#migrating-to-500); from CLI
2.x: *Migrating to 3.0.0* in the [CLI README](../../packages/auth-broker-cli/README.md#migrating-to-300).

## Prerequisites

- **Node.js**: 22, 24 or 26 (`engines: "^22 || ^24 || ^26"`; 22 and 24 are the versions SAP BTP
  Cloud Foundry offers)
- **npm**: comes with Node.js
- **SAP BTP account**: for service keys (if you log in through UAA / XSUAA)

## Installation

### The library

```bash
npm install @mcp-abap-adt/auth-broker @mcp-abap-adt/auth-providers @mcp-abap-adt/auth-errors @mcp-abap-adt/auth-stores
```

The library depends on `@mcp-abap-adt/auth-providers` 6 and `@mcp-abap-adt/auth-errors` 2, but
declare them yourself: your code imports the renewal strategies (`refreshThenLogin`,
`refreshOnly`) and the interactive strategies from auth-providers, and reads failures with
auth-errors. The stores are yours to choose: `@mcp-abap-adt/auth-stores` 4, or your own on the
`@mcp-abap-adt/interfaces-auth-broker` contracts. Everything must be on the same contract majors
(`@mcp-abap-adt/interfaces-auth` 7): check that one copy of each is installed —

```bash
npm ls @mcp-abap-adt/interfaces-auth @mcp-abap-adt/auth-errors
```

### The command

```bash
npm install -g @mcp-abap-adt/auth-broker-cli
mcp-auth --version   # 3.0.0
```

Its only bin is `mcp-auth`; the `mcp-sso` command of 2.x is gone (every form of it is an
`mcp-auth` subcommand). If you installed `@mcp-abap-adt/auth-broker` globally for the commands
(3.0.4 or earlier), swap it:

```bash
npm uninstall -g @mcp-abap-adt/auth-broker && npm i -g @mcp-abap-adt/auth-broker-cli
```

### Verify Installation

```bash
npm list @mcp-abap-adt/auth-broker
```

## Configuration

### Service Key Setup

1. **Obtain a service key** from the SAP BTP Cockpit for your ABAP system.
2. **Save it** as `{destination}.json`.

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

A service key holds the client and the URL, never which grant the destination uses: whoever
builds the key store states it — `new AbapServiceKeyStore(dir, { grantType:
'authorization_code' })`.

### Environment File Setup

A destination may also be stated in `{destination}.env` — what `mcp-auth` writes, or a file you
write yourself. With auth-stores 4 the file has two roles: the means, read by
`EnvDestinationStore`, and the secret, written by the broker through a session store
(`AbapSessionStore`); each touches only its own keys.

Example: `TRIAL.env`
```env
# the means — you (or mcp-auth) write these; the broker never does
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
SAP_ISSUED_BY=mcp-abap-adt-binding/2;jwt/authorization_code;...
```

## File Locations

Where files live is the stores' concern (`@mcp-abap-adt/auth-stores`), not the broker's: each
store takes its directory in its constructor, with no default, and the library reads no
environment variable for it.

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

The `mcp-auth` command's `--destination <name>` looks in `<dir>/sessions/` and
`<dir>/service-keys/`, `<dir>` being `--destination-dir`, else the folders of `AUTH_BROKER_PATH`
(the server's variable), else `~/.config/mcp-abap-adt` on Unix and
`<home>\Documents\mcp-abap-adt` on Windows.

## Quick Start

1. **Install the packages**:
   ```bash
   npm install @mcp-abap-adt/auth-broker @mcp-abap-adt/auth-providers @mcp-abap-adt/auth-errors @mcp-abap-adt/auth-stores
   ```

2. **Save the service key** as `TRIAL.json` in a directory of your choice.

3. **Use it in code**:
   ```typescript
   import { AuthBroker } from '@mcp-abap-adt/auth-broker';
   import {
     browserCallbackStrategy,
     linuxDefaultBrowser,
     refreshThenLogin,
   } from '@mcp-abap-adt/auth-providers';
   import { AbapServiceKeyStore, AbapSessionStore } from '@mcp-abap-adt/auth-stores';

   const broker = new AuthBroker({
     serviceKeyStore: new AbapServiceKeyStore(process.cwd(), {
       grantType: 'authorization_code',
     }),
     sessionStore: new AbapSessionStore(process.cwd()),
     renewal: () => refreshThenLogin(),
     onWriteFailure: 'fail',
     authorization: () => browserCallbackStrategy({ browser: linuxDefaultBrowser() }),
   });

   const provider = await broker.getProvider('TRIAL'); // for a connection 14 connector
   const token = await broker.getToken('TRIAL');       // the same provider's token
   await broker.flush();                               // every token stored?
   ```

4. **First run**: the browser opens for the login (the URL is also shown on stderr). After it,
   the session store holds the secret — with `AbapSessionStore`, in `TRIAL.env` beside the key.
   The next run reuses it while it is valid and bound to the same means, refreshes it when it
   expired, and logs in again only when it must.

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

`mcp-auth` works in a private temporary directory (`0700`) removed on every exit, and writes
nothing else but the output you name.

### Version Control

**Never commit** `*.env` files (they hold tokens) or service key `*.json` files (they hold
credentials):

```
*.env
*.json
!package.json
!package-lock.json
```

### Rotating Credentials

Rotate service keys regularly. A changed URL, SAP client, client, grant, server address or
trust value costs one fresh login: the stored secret is bound to exactly the means it was
obtained under and is not reused under others — even a cosmetic change of an address (a trailing
`/`) counts.

## Troubleshooting

### File Not Found Errors

1. **Check the directories** given to each store's constructor (or `--destination-dir` /
   `AUTH_BROKER_PATH` for `mcp-auth --destination`).
2. **Check the file names**: `{destination}.env` and `{destination}.json`.

### Browser Authentication Issues

1. **No browser opened**: the URL is shown on stderr; open it by hand. `mcp-auth --browser none`
   never tries; `--browser-program <program>` names one.
2. **The callback port is busy**: the callback port comes from `@mcp-abap-adt/auth-providers`
   (currently `61001`) unless overridden — `browserCallbackStrategy({ port })`, or
   `mcp-auth --redirect-port`.
3. **The browser runs on another machine**: the callback listens on loopback only; tunnel the
   port (`ssh -L 61001:localhost:61001 …`).
4. **A login never ends**: there is no time limit; end it with Ctrl+C, or pass a signal
   (`AbortSignal.timeout(ms)`) in your own code.

### `DestinationConfigError`

`getProvider` (and the token API) name what a destination lacks in `missingFields` — a field of
the key store (`authType`, `grantType`, `uaaUrl`, …), a session field (`issuedFor`, `issuedBy`,
`authorizationToken` for a `none` destination), a collaborator option (`authorization`, …), or
`renewal` / `onWriteFailure`, which have no default. A `jwt` / `saml` file that states no
`SAP_GRANT_TYPE` is refused naming `grantType`.

### A Login After Upgrading

Every session written before auth-broker 5.0.0 reads as unbound once: each token destination
logs in once (interactive grants) or requests a token once (`client_credentials`, `password`,
`token_exchange`). Run `mcp-auth --env <file>` (or `--service-key`) once per destination for a
headless consumer.

### Token Refresh Issues

1. **Check the refresh token**: valid and not expired (a refused refresh is discarded; the
   renewal strategy then logs in, or with `refreshOnly()` stops).
2. **Check the client**: the service key's UAA configuration.
3. **Check the network**: connectivity to the UAA.

## Next Steps

- See [Usage Guide](../using/USAGE.md) for API documentation and examples
- See [Architecture](../architecture/ARCHITECTURE.md) for technical details
- See [Testing](../development/TESTING.md) for development and testing guide
