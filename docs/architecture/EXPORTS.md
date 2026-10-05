# Exported Entities

This document lists the public exports of `@mcp-abap-adt/auth-broker` 4.1.0 and how they relate.

## Primary Exports

### `AuthBroker`
The credential a destination states (`getProvider`), its persistence, and the token API.

**Export**:
```typescript
export {
  AuthBroker,
  type AuthBrokerConfig,
  type StrategyGrant,
  type TokenProviderClient,
  type TokenProviderFactory,
} from './AuthBroker';
```

**Constructor**: `new AuthBroker({ sessionStore, serviceKeyStore?, provider?, …collaborators }, logger?)`, where
`provider` — a token API source of your own, optional, never used by
`getProvider`; without it the token API asks `getProvider`'s provider — is an
`IRefreshableTokenProvider` or a `TokenProviderFactory`
`(destination, authConfig, connConfig, client?) => IRefreshableTokenProvider`
— `client` (`TokenProviderClient`: the strategy's `clientAuthentication`, the
client identity `uaaUrl` / `clientId`, and a bound `refreshToken`; never a
certificate, key or secret) only beside a `clientAuthentication` strategy, for
a grant that authenticates a client. The
collaborator options (`authorization`, `oidcAuthorization`,
`deviceCodePresenter`, `samlCookies`, `assertionReplayStore`) are each a
function of the destination; `StrategyGrant` is the grant `authorization` is
called with (`'authorization_code' | 'passcode' | 'saml2_pure' | 'saml2_bearer'`).
Each is required only by the destination rows that use it: `authorization`
by `authorization_code`, `passcode`, `saml2_pure`, `saml2_bearer`;
`oidcAuthorization` by `oidc_authorization_code`; `deviceCodePresenter` by
`device_code`; `samlCookies` by `saml2_pure`; `assertionReplayStore` by both
SAML grants. Their types come from the packages that declare them:
`IAuthorizationStrategy`, `IAssertionReplayStore` from
`@mcp-abap-adt/interfaces-auth`; `OidcCallbackResult`, `IDeviceCodePresenter`
from `@mcp-abap-adt/auth-providers` — none is re-exported here.

**Key methods**:
- `getProvider(destination: string): Promise<IAuthProvider>` — the provider the destination states, from the key store's means and the session's secret — the secret used only when its `issuedFor` / `issuedBy` are the destination's; cached per destination
- `getToken(destination: string): Promise<string>` — the token of the destination's provider (`getProvider`'s, shared; or the `provider` option's); refuses a destination stated `basic` or `snc`
- `refreshToken(destination: string): Promise<string>` — a forced refresh (`provider.refreshTokens()`), joining a renewal in flight
- `getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null>` — the key store's client with the session's refresh token
- `getConnectionConfig(destination: string): Promise<IConnectionConfig | null>` — the key store's means with the session's secret and its binding (`issuedFor`, `issuedBy`)
- `createTokenRefresher(destination: string): ITokenRefresher` — `getToken` / `refreshToken` bound to one destination; unchanged since 3.x, not deprecated
- `flush(): Promise<void>` — one more attempt for every session write left pending (by `getProvider`'s providers or the token API); rejects with an `AggregateError` naming the destinations still failing

### Client authentication (4.1.0)

**Export**:
```typescript
export {
  type ClientAuthenticationContext,
  type ClientAuthenticationGrant,
  type ClientAuthenticationStrategy,
  type FromServiceKeySecretOptions,
  fromServiceKeyCertificate,
  fromServiceKeySecret,
} from './clientAuthentication';
```

`AuthBrokerConfig.clientAuthentication` takes a `ClientAuthenticationStrategy`
`(context: ClientAuthenticationContext) => Promise<IClientAuthentication>`,
called once per build of a destination whose grant (`ClientAuthenticationGrant`:
the UAA and OIDC grants, `saml2_bearer`) authenticates a client; the context
carries `destination`, `grant`, `client` (the key store's secret client —
`uaaUrl`, `uaaClientId`, `uaaClientSecret` only, never a refresh token — or
`null`) and a lazy `readCertificate()`. `fromServiceKeyCertificate()` answers
auth-providers' `tlsClientCertificate` from the key store's certificate client
(`<certUrl>/oauth/token`, material checked before answering);
`fromServiceKeySecret({ encoding: 'raw' | 'form' })` its `clientSecretBasic`.
Each throws when its client is unavailable; the broker turns any throw into a
`DestinationConfigError` naming `clientAuthentication`, in fixed words.

### `bindingOf`

**Export**:
```typescript
export { bindingOf, type SecretBinding } from './bindingOf';

function bindingOf(
  means: IConnectionConfig,
  client?: IAuthorizationConfig | null,
): SecretBinding; // { issuedFor?: string; issuedBy?: string }
```

For a consumer that hands over a credential (a `none` destination's token or
cookies) and writes it to the session store itself: the binding to write beside
it — canonical, and computed by the same function `getProvider` checks against
and `persist` writes, so the two cannot diverge. `means` are the key store's;
`client` its client, when the destination has one. `{}` for a destination that
states no `jwt` / `saml` type or no grant.

### `DestinationConfigError`
What `getProvider` and the token API throw for a destination that lacks what
its type needs — and the token API for one stated `basic` or `snc`
(`authType`), a `none` one without a `provider` option (`provider`), or
neither a `provider` nor a `serviceKeyStore` (both).

**Export**:
```typescript
export { DestinationConfigError } from './DestinationConfigError';
```

**Shape**:
```typescript
class DestinationConfigError extends Error {
  readonly code: 'DESTINATION_CONFIG';
  readonly destination: string;
  readonly missingFields: string[]; // field or option names only, never a value
}                                   // no cause: a provider's error quotes values
```

`IAuthProvider` is not re-exported: take it from `@mcp-abap-adt/interfaces-auth`.

### Interfaces (for consumers)

These are the stable interfaces consumers should use. The store contracts
(`IConnectionConfig`, `IServiceKeyStore`, `ISessionStore`, and `IConfig` below)
come from `@mcp-abap-adt/interfaces-auth-broker` 1.2 (1.1.0 added `issuedFor`
and `issuedBy` to `IConnectionConfig`; 1.2.0 the optional
`IServiceKeyStore.getClientCertificate` and `IClientCertificate`, re-exported
here); `IAuthorizationConfig` from
`@mcp-abap-adt/interfaces-auth-sap` 2. Up to 3.x the store contracts came from
`interfaces-auth-sap`; the names re-exported here are unchanged.

```typescript
export type {
  IAuthorizationConfig,
  IConnectionConfig,
  IServiceKeyStore,
  ISessionStore,
} from './stores/interfaces';
```

```typescript
export type { IConfig } from './types';
```

### Provider Interface

`IRefreshableTokenProvider` is what the token API requires of a `provider` you
give it; `ITokenProvider` is its base. `getProvider` hands out an `IAuthProvider`
(not re-exported: take it from `@mcp-abap-adt/interfaces-auth`).

```typescript
export type {
  IRefreshableTokenProvider,
  ITokenProvider,
  ITokenResult,
  TokenProviderOptions,
} from './providers';
```

**Shapes** (from `@mcp-abap-adt/interfaces-auth` 3.0.0):
```typescript
export interface ITokenProvider {
  getTokens(): Promise<ITokenResult>;
  validateToken?(token: string, serviceUrl?: string): Promise<boolean>;
}

export interface IRefreshableTokenProvider extends ITokenProvider {
  /** A new token, never the cached one. */
  refreshTokens(): Promise<ITokenResult>;
}
```

### Convenience Re-exports

```typescript
export type {
  IClientAuthentication,
  ITokenRefresher,
} from '@mcp-abap-adt/interfaces-auth';
export type { IClientCertificate } from '@mcp-abap-adt/interfaces-auth-broker';
export type { AuthType } from '@mcp-abap-adt/interfaces-auth-sap';
export type { ILogger } from '@mcp-abap-adt/interfaces-utils';
```

## External Implementations

Concrete implementations are **not** in this package:
- Stores live in `@mcp-abap-adt/auth-stores`.
- Providers live in `@mcp-abap-adt/auth-providers` 5 — a runtime dependency,
  since `getProvider` builds `BasicAuthProvider`, `SncLogonProvider`,
  `TokenAuthProvider`, `SamlAuthProvider`, `AuthorizationCodeProvider`,
  `ClientCredentialsProvider`, `UaaPasscodeProvider`, `OidcBrowserProvider`,
  `OidcDeviceFlowProvider`, `OidcPasswordProvider`,
  `OidcTokenExchangeProvider`, `Saml2PureProvider` and `Saml2BearerProvider`
  (with the SAML validators it composes); none of them is re-exported.

## Minimal Relationship Diagram

```mermaid
flowchart TD
  AB[AuthBroker] --> SS[ISessionStore]
  AB --> SK[IServiceKeyStore]
  AB --> TP[IRefreshableTokenProvider]
  AB -->|getProvider| AP[IAuthProvider]
  SS -->|the secret| ICfg[IConfig]
  SK -->|the means| IConn[IConnectionConfig]
  SK -->|the client| IAuth[IAuthorizationConfig]
  TP --> IToken[ITokenResult]
```
