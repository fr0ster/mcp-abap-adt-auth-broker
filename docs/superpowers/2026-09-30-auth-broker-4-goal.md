# auth-broker 4.0.0 — goal and path

**Status:** draft goal, for review in this PR. The spec and then the plan come
next, in this PR. This file is the anchor: it says what they are for, and what
neither may trade away. If the spec or the plan needs to depart from anything
under *Holds throughout*, this file changes first — explicitly, in review.

## Goal

`@mcp-abap-adt/auth-broker` 4.0.0 hands a process **the credential for a
destination, ready to use**: `getProvider(destination)` returns an
`IAuthProvider` (`@mcp-abap-adt/interfaces-auth` 3.0.0) that a
`@mcp-abap-adt/connection` 10 connector takes as it is — basic, a token
provider, SNC — already paired with the stores, so whatever the provider
obtains or renews is kept, whoever triggered it.

The token API stays for consumers that want a token and nothing else
(`getToken`, `refreshToken`, `createTokenRefresher` — `mcp-calm-*`).

**Success:** the server builds its connector from `getProvider(destination)`
with no per-auth-type code of its own, for a basic destination, a token
destination and an SNC destination; a token the provider renews inside the
connector (on a 401, through `rejected()`) is found in the session store
afterwards; and the token API behaves as in 3.x.

## What changes

- **`getProvider(destination): IAuthProvider`.** The broker builds the provider
  the destination's configuration states (`IConnectionConfig.authType`:
  `basic`, `jwt`, `saml`, `snc` — `@mcp-abap-adt/interfaces-auth-sap` 1.1.0),
  from the stores it already reads:
  - `basic` → `BasicAuthProvider(username, password)`;
  - `jwt` (a token destination) → a token provider seeded from the session and
    the service key, as today's factories do;
  - `saml` → the SAML providers (cookies or bearer), as `mcp-sso` configures them;
  - `snc` → `SncLogonProvider` from `sncPartnerName`, `sncQop`, `sncLib`,
    `sncMyName`.
- **Persistence moves to the provider's `onTokens`.** The broker wires each
  token provider it hands out to the session store, so a renewal the
  connector triggers (`prepare()`, `rejected()`) is written back — not only a
  token obtained through `getToken`.
- **No implicit defaults** (auth-providers 5, rule 7): every collaborator a
  provider needs — the interactive strategy, the device-code presenter, the
  SAML validator and replay store, the SNC locator and probes — is supplied
  explicitly.
- **The commands move to `@mcp-abap-adt/auth-broker-cli`**, a second package
  in this repository (decided 2026-09-30). The repository takes the layout of
  `mcp-abap-adt-interfaces` and `llm-agent` (decided 2026-10-01): a private
  workspace root, every package under `packages/` —
  `packages/auth-broker` (the library, still `@mcp-abap-adt/auth-broker`) and
  `packages/auth-broker-cli` — and `release:publish` publishing the packages
  that changed, as `mcp-abap-adt-interfaces`' tools do. `mcp-auth`,
  `mcp-sso` and `generate-env-from-service-key` leave this package, which
  becomes the library alone (no `bin`). The CLI package depends on this one
  and on `@mcp-abap-adt/auth-stores`, and stops relying on auth-providers
  4.x defaults: the device-code presenter, the SAML `assertionValidator` in
  place of `idpCertificates`, the manual strategy's `read(prompt, signal)`.
  The library's API is unaffected; only the install command for the CLIs
  changes.
- **Dependencies:** `@mcp-abap-adt/auth-providers` ^5.0.1,
  `@mcp-abap-adt/interfaces-auth` ^3.0.0, `@mcp-abap-adt/interfaces-auth-sap`
  ^1.1.0. `@mcp-abap-adt/auth-stores` leaves the runtime dependencies with
  the commands: the library never imports it (hold 0); its tests may use it
  as a dev dependency.
- **The session's `authType` is not overwritten.** `persist()` writes `jwt` or
  `saml` over whatever the session said; a `basic` or `snc` destination must
  stay what it is.

**Stays:** the stores and their contracts (`ISessionStore`, `IServiceKeyStore`);
the rule that a client secret is never copied into the session; the token API
and `createTokenRefresher`; injecting a provider or a factory, for a consumer
that builds its own.

## Holds throughout

0. **The broker speaks the store contracts, never a storage.** A destination is
   a name the stores resolve — a service key, a session, anything a store
   holds. The broker reads and writes only through `ISessionStore` /
   `IServiceKeyStore` (`@mcp-abap-adt/interfaces-auth-sap`), so any
   implementation serves: files, memory, a database, a message log.
   `@mcp-abap-adt/auth-stores` is the file implementation shipped beside it,
   not something the broker knows. What `getProvider` needs and the contract
   cannot carry is added to `interfaces-auth-sap`, not to a store.
1. **The destination's configuration states the provider; nothing is
   inferred** — not from the host, not from the shape of a service key.
2. **No implicit defaults.** The broker passes every collaborator explicitly;
   where one must come from the consumer (an interactive strategy), the
   consumer supplies it.
3. **What a provider obtains or renews reaches the session store**, whether the
   broker, the connector or the provider itself triggered it.
4. **The broker stores no secret it was not given to store**; a client secret
   never lands in the session.
5. **The token API keeps its 3.x behaviour** for the consumers that use it.
6. **Measured:** a basic, a token and an SNC destination, through a connection
   10 connector, on real systems (SNC on Windows).

## Open, for the spec

1. **Where the interactive strategy comes from.** `getProvider` for a token
   destination may need to log in: a strategy per call, per broker, or per
   destination — and what a headless process (the server) passes.
2. **Which provider for a token destination.** Today's factories choose between
   authorization code and client credentials from the service key; the
   destination should state it.
3. **Caching.** One provider per destination for the broker's life (as the
   factory path caches today), shared by `getProvider` and the token API?
4. ~~Certificates~~ — decided (2026-09-30): out of scope. `IConnectionConfig`
   carries no certificate fields, and no system with a certificate mapping is
   at hand. A later step of its own: the fields in a contract (possibly a
   more general one than `interfaces-auth-sap` — client-certificate logon is
   not ABAP-specific), the stores, the broker, and a stand — Keycloak with a
   test CA, X.509 user logon and mTLS client authentication (RFC 8705).
   A consumer that needs certificates now passes its own provider factory.
5. **What the store contract must carry.** `basic` needs `username` /
   `password`, `snc` its four fields, a certificate its material — whether
   `IConnectionConfig` (interfaces-auth-sap 1.1.0) already carries each, and
   what a store must accept back when a provider renews.

## Path

1. ~~`interfaces-auth` 3.0.0, `interfaces-auth-sap` 1.1.0~~ — released.
2. ~~`@mcp-abap-adt/auth-providers` 5.0.1~~ — released.
3. ~~`@mcp-abap-adt/connection` 10.0.2~~ — released.
3a. ~~`@mcp-abap-adt/auth-stores` 2.0.0~~ — released: on `interfaces-auth`
    ^3.0.0 and `interfaces-auth-sap` ^1.1.0; the ABAP session stores keep
    `authType` (`SAP_AUTH_TYPE`), read and write the SNC fields, and hold one
    credential per session — a config carrying two without `authType` is
    refused, so the broker always declares it.
4. **This package, 4.0.0** — in this PR: goal → review → spec → review → plan →
   review → implementation → external review → merge → release. ← now
4a. `@mcp-abap-adt/auth-broker-cli` 1.0.0 — the commands from 3.x, on broker
    4 and auth-stores 2; released right after 4.0.0, so there is no gap in
    which neither package ships `mcp-auth`. Its check installs the packed
    tarball into an empty directory and runs each bin (3.0.4 shipped a bin
    that died on `MODULE_NOT_FOUND`).
5. `mcp-abap-adt` — the provider from the broker into the connector; the
   per-auth-type construction and the broker 3.x call removed. Live check:
   basic over HTTP and RFC, a token destination, SNC over RFC — one code path.
   Its docs install `@mcp-abap-adt/auth-broker-cli` for `mcp-auth`.
