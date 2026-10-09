# Documentation

Complete documentation for the `@mcp-abap-adt/auth-broker` repository: the library
(`packages/auth-broker`, 5.0.0) and its command, `@mcp-abap-adt/auth-broker-cli`
(`packages/auth-broker-cli`, 3.0.0). Upgrading: *Migrating to 5.0.0* in the
[library README](../packages/auth-broker/README.md#migrating-to-500), and *Migrating to
3.0.0* in the [CLI README](../packages/auth-broker-cli/README.md#migrating-to-300); earlier
migrations are in each package's CHANGELOG.

## Quick Start

- [Repository README](../README.md) - The workspace: both packages, commands, releases
- [Library README](../packages/auth-broker/README.md) - `@mcp-abap-adt/auth-broker`: installation, API, configuration
- [CLI README](../packages/auth-broker-cli/README.md) - the `mcp-auth` command
- [Installation Guide](installing/INSTALLATION.md) - How to install and set up the package
- [Usage Guide](using/USAGE.md) - API documentation and usage examples

## Documentation Structure

```
docs/
├── README.md                    # This file - documentation index
├── architecture/
│   ├── ARCHITECTURE.md         # System architecture and design
│   └── EXPORTS.md              # Exported entities and object diagrams
├── development/
│   ├── TESTING.md              # Where the suites live, how to run them, the checks
│   ├── DEVELOPMENT_ROADMAP.md  # The 0.x roadmap — historical
│   ├── MIGRATION_GUIDE_v0.2.0.md # The 0.2.0 migration — historical
│   └── archive/                # Older analyses — historical
├── installing/
│   └── INSTALLATION.md         # Installation and setup guide
└── using/
    └── USAGE.md                # API reference and usage examples
```

## Sections

### [Architecture](architecture/)
Technical documentation about the system architecture, design decisions, and internal structure:
- **[ARCHITECTURE.md](architecture/ARCHITECTURE.md)** - System architecture, design decisions, and component overview
- **[EXPORTS.md](architecture/EXPORTS.md)** - Complete list of exported entities, object relationship diagrams, and usage patterns

### [Development](development/)
Documentation for developers:
- **[TESTING.md](development/TESTING.md)** - Where the suites live, what they need, the release checks
- **[DEVELOPMENT_ROADMAP.md](development/DEVELOPMENT_ROADMAP.md)** - The roadmap written for 0.1.0; historical, not a description of the current packages

### [Installing](installing/INSTALLATION.md)
Installation and setup guide:
- Prerequisites
- NPM installation
- Configuration
- Environment setup

### [Using](using/USAGE.md)
API reference and usage examples:
- Basic usage
- API methods
- Configuration options
- Examples
- Error handling

## Key Concepts

### AuthBroker Class

For a destination name:
- **getProvider()** - The `IAuthProvider` the destination states (basic, SNC, a UAA, OIDC or SAML grant, a credential handed over), built from the key store's means and the session store's secret, for a `@mcp-abap-adt/connection` 14 connector; everything it obtains is stored back, bound to the means it was obtained under; rebuilt when those means change
- **getToken()** - The destination's current token (cached while valid, else renewed as the `renewal` strategy says) — from `getProvider`'s provider, or from a `provider` you give the broker
- **refreshToken()** - A new token, never the cached one (`refreshTokens()`)
- **createTokenRefresher()** - `ITokenRefresher` for one destination, for injection into a connection of your own
- **flush()** - Whether every session write has landed; nothing retries a pending write on its own, so call it on shutdown
- Every call takes `{ signal }`; `renewal` and `onWriteFailure` are the consumer's, with no default

### Two Stores, Two Roles

- **The service key store** (`IServiceKeyStore`) answers the *means*: `authType`, `grantType`, the client, user and password, the SNC, OIDC and SAML settings, the URL — and a client certificate (`getClientCertificate`, read only beside a `clientAuthentication` strategy). The broker never writes it.
- **The session store** (`ISessionStore`) holds the *secret*: the token or cookies, its expiry, the refresh token, and what it is bound to (`issuedFor`, and `issuedBy` — a versioned record of the row, the client, every server address and the trust). The broker writes the secret alone, every field stated; the store must settle every `saveSession`.

Where they live is the stores' business: `@mcp-abap-adt/auth-stores` 4 keeps both in `{destination}.env` files (and reads SAP service keys, `{destination}.json`), in the directories you give each store's constructor; any implementation of the contracts serves.
