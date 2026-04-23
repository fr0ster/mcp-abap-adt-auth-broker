# Public-client Authorization Code Flow for MCP ABAP ADT Auth Broker

**Status:** Draft (revision 3 — simplified scope)
**Date:** 2026-04-22
**Branch:** `feat/url-pkce-auth`

## Problem

The broker today bootstraps an ABAP session from a JSON service key that contains `url`, `clientid`, and `clientsecret`. It runs OAuth2 authorization code in the browser via `AuthorizationCodeProvider`, which mandates `clientsecret` (`AuthorizationCodeProvider.ts:72`).

Real case we want to cover: the user has no service key and no access to issue one, but does have:

- the ABAP system URL,
- the UAA (XSUAA) URL,
- a `client_id` for a public OAuth client registered with `localhost` redirect.

Current code rejects this because `clientsecret` is required.

## Goal

Extend the existing authorization-code path to support a **public client** (PKCE, no `client_secret`). Two phases:

1. **Phase 1 — make it work via CLI.** `mcp-auth` learns to take `--abap-url --uaa-url --client-id` directly (no service-key file), runs the public-client flow, and writes a valid `.env`.
2. **Phase 2 — give it a file format.** A YAML "service key" file mirrors the JSON service key for the public-client case; a custom `IServiceKeyStore` reads it and is plugged in wherever the JSON store is used today.

OIDC discovery, IdP scraping, and `mcp-sso` integration are all explicitly out of scope.

## Probe Findings (real BTP target)

Validated against a real ABAP cloud system:

- XSUAA `/oauth/authorize` accepted the user-supplied `client_id` (`sb-xs-...!b614777|xsuaa-abapcp-prod-eu10!b4584`), `redirect_uri=http://localhost:8765/callback`, and PKCE `S256` — proceeded straight to the standard login page without `invalid_redirect_uri` / `invalid_client`.
- The foreign-scope suffix `|xsuaa-abapcp-prod-eu10!b4584` ensures the issued JWT carries the audience the ABAP system expects.
- End-to-end token exchange and ADT call have not yet been executed; final acceptance happens during implementation.

## Phase 1 — CLI bootstrap

### CLI surface

```
mcp-auth --abap-url <url> --uaa-url <url> --client-id <id> [--port <n>] --output ./mcp.env
```

- Mutually exclusive with `--service-key`.
- `--port` defaults to a random free port; `redirect_uri = http://localhost:<port>/callback`.
- `--scope` fixed to `openid` (XSUAA inherits required scopes via the foreign-scope suffix in `client_id`).

### Provider wiring

`AuthorizationCodeProvider` is left untouched (still secret-required). The public-client path uses `OidcBrowserProvider`, which already implements PKCE `S256` without a secret. CLI logic:

```
if (--service-key) → AuthorizationCodeProvider (existing)
if (--abap-url --client-id) → OidcBrowserProvider (existing, new wiring in CLI)
```

`OidcBrowserProvider` is named "Oidc" in the codebase but mechanistically it is OAuth2 authorization_code + PKCE for a public client. We do not introduce a new provider.

### Storage

Reuse existing `BTP_*` env vars (`@mcp-abap-adt/auth-stores/utils/constants`):

| Field | Env var |
|---|---|
| ABAP system URL | `BTP_ABAP_URL` |
| UAA URL | `BTP_UAA_URL` |
| Client ID | `BTP_UAA_CLIENT_ID` |
| Client secret | `BTP_UAA_CLIENT_SECRET` (empty / omitted) |
| Access token | `BTP_JWT_TOKEN` |
| Refresh token | `BTP_REFRESH_TOKEN` |

Schema is unchanged. Empty `BTP_UAA_CLIENT_SECRET` is the marker for "this is a public client; refresh without secret". If the existing session loader rejects an empty secret, the smallest possible tolerance change is added at that one site (validated during implementation, not designed in advance).

### Refresh

Standard XSUAA refresh-token grant against `${BTP_UAA_URL}/oauth/token` with `client_id` only (no secret). Whether XSUAA issues a refresh token for the registered client is registration-dependent and observed in implementation. If absent, behavior falls back to the existing `allowBrowserAuth` branch (`AuthBroker.ts:77,89,176`): re-launch browser when allowed, throw typed error otherwise.

No new broker API. No new store. No new provider class.

## Phase 2 — YAML service key (deferred, analyzed only)

### Motivation

Carrying `--abap-url --uaa-url --client-id` on every CLI invocation is fine for one-off bootstrap but inconvenient for repeated use and for any tooling that already loads service keys by destination name. A file-based representation of the same information lets the public-client case slot into existing service-key code paths.

### File format

Mirror of the JSON service key, minus the secret, in YAML for readability:

```yaml
# <destination>.yaml
type: xsuaa-public-client
abap_url: https://b0c732e4-....abap.eu10.hana.ondemand.com
uaa_url:  https://esup-idp-sandbox-....authentication.eu10.hana.ondemand.com
client_id: 'sb-xs-...!b614777|xsuaa-abapcp-prod-eu10!b4584'
# no client_secret on purpose — public client with PKCE
```

Required fields: `abap_url`, `uaa_url`, `client_id`. The `type: xsuaa-public-client` discriminator distinguishes it from any future YAML format and from the JSON service key.

### Custom `IServiceKeyStore`

Today the broker accepts an `IServiceKeyStore` (interface). A new implementation, e.g. `XsuaaPublicClientYamlServiceKeyStore`, lives in `@mcp-abap-adt/auth-stores`:

- Loader: reads `<destination>.yaml` (parser already established by `XsuaaServiceKeyParser` pattern in `loaders/xsuaa/xsuaaServiceKeyLoader.ts`).
- Parser: validates required fields and `type` discriminator; rejects YAMLs that contain `client_secret` (would be a config mistake — use the JSON store instead).
- Returned shape: matches the existing `ServiceKey` contract so downstream code does not branch — except for an explicit "public client" flag the broker can read to decide between `AuthorizationCodeProvider` and `OidcBrowserProvider`.

Wherever consumers construct a JSON service-key store today, they may construct the YAML store instead. The broker's `IServiceKeyStore` consumer code does not change.

### Why deferred

Phase 2 needs:
- a clear contract change on `ServiceKey` (or a sibling type) to surface "public client" without polluting the JSON case;
- broker-side provider selection driven by that contract (this is the dynamic-selection refactor we previously called option B);
- consumer plumbing (`mcp-abap-adt`, `mcp-abap-adt-proxy`) to actually point at the YAML store when appropriate.

These are tractable but each carries test surface. Phase 1 is the smallest path to "user gets valid tokens from URL + client_id today". Phase 2 lifts that capability into the existing destination-based store mechanism once Phase 1 is proven.

## Component Inventory

| Component | Phase 1 | Phase 2 |
|---|---|---|
| `@mcp-abap-adt/auth-stores` | none (or one tolerance line for empty secret) | new YAML loader/parser/store |
| `@mcp-abap-adt/auth-providers` | none | none |
| `@mcp-abap-adt/auth-broker` (`AuthBroker.ts`) | none if loader tolerates empty secret | provider-selection branch driven by store output |
| `bin/mcp-auth.ts` | new `--abap-url --client-id` mode wiring `OidcBrowserProvider` | accept `--public-service-key file.yaml` for symmetry |
| `mcp-abap-adt`, `mcp-abap-adt-proxy` | docs only | wire YAML store as alternative; docs |

## Testing

Phase 1, gated like the existing browser test:

- End-to-end against the probed ABAP target: `mcp-auth --abap-url ... --uaa-url ... --client-id ...` opens browser, user logs in, `.env` written with non-empty `BTP_JWT_TOKEN`, broker refreshes successfully on the next call, and one ADT GET succeeds with that token.
- Whether a refresh token was issued is observed and recorded; behavior is verified for both outcomes.

Unit:
- CLI argument parsing for the new mode (mutual exclusion with `--service-key`, missing required combos).
- `.env` round-trip: written file is loadable by the existing session store with empty `BTP_UAA_CLIENT_SECRET`.

Phase 2 testing is deferred with the implementation.

## Open Risks

- Whether the existing session loader/store tolerates an empty `BTP_UAA_CLIENT_SECRET` is unverified. If not, a one-line tolerance change at the loader is the expected fix; if it triggers wider validation, the design is reconsidered before Phase 2.
- Refresh-token availability for public clients is registration-dependent. Mitigation: fall back to `allowBrowserAuth` semantics that already exist.
- End-to-end PKCE has not been executed against the probed target yet; only the `/oauth/authorize` precondition has been verified.
