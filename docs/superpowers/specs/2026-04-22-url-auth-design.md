# URL-based PKCE Authentication for MCP ABAP ADT Auth Broker

**Status:** Draft
**Date:** 2026-04-22
**Branch:** `feat/url-pkce-auth`

## Problem

The auth broker currently requires a BTP service key (JSON file) to bootstrap authentication for an ABAP system. Users who do not have access to download a service key — but who do have:

- The ABAP system URL
- An XSUAA `client_id` registered with `localhost` redirect and a foreign-scope reference to the ABAP system's `xsappname`

— cannot use the broker today. Eclipse ADT supports such flows via embedded-browser SSO; we want analogous coverage so that `mcp-abap-adt` and `mcp-abap-adt-proxy` can consume any system the user has UI access to.

A "URL-only with no client_id" mode was investigated and ruled out: BTP ABAP systems require a registered OAuth2 client (no anonymous token issuance), and Eclipse's apparent "URL-only" flow on Steampunk reduces to Basic Auth with user/password. Basic Auth has no token lifecycle and therefore does not belong in the broker — consumers handle it directly when needed.

## Goal

Add a second bootstrap path to the broker: **URL + client_id → PKCE browser flow → JWT**. Existing service-key flow remains unchanged. Consumer services (`mcp-abap-adt`, `mcp-abap-adt-proxy`) require no code changes.

## Probe Findings (real BTP ABAP target)

Validated against `https://b0c732e4-462a-4cad-b1f3-f27c37cc2dbf.abap.eu10.hana.ondemand.com`:

- ABAP host: no OIDC discovery, no anonymous OAuth2; `/sap/bc/adt/*` returns `WWW-Authenticate: Basic`.
- `abap-web` router redirects `/ui` to an XSUAA tenant; the tenant URL can be scraped from the HTML.
- XSUAA tenant (`https://esup-idp-sandbox-6iwr9oqc.authentication.eu10.hana.ondemand.com`) exposes full OIDC discovery, supports PKCE `S256`, does **not** expose `device_code` grant.
- Given the user-supplied `client_id` `sb-xs-...!b614777|xsuaa-abapcp-prod-eu10!b4584`:
  - `/oauth/authorize` accepts `redirect_uri=http://localhost:8765/callback` and PKCE without complaint (proceeds to login).
  - The foreign-scope suffix `|xsuaa-abapcp-prod-eu10!b4584` ensures issued JWTs carry the audience the ABAP system expects.

Conclusion: PKCE browser flow with URL + client_id is technically achievable for this class of systems.

## Architecture

### Mode selection

The two modes (`service-key`, `url-pkce`) are conceptual; they are not stored as an explicit discriminator. `AuthBroker` derives the mode at runtime from the presence of `BTP_UAA_CLIENT_SECRET`:

| Stored state | Provider |
|---|---|
| `client_id` + `client_secret` (+ refresh token) | `AuthorizationCodeProvider` (existing) |
| `client_id` only, no secret | `OidcBrowserProvider` (PKCE, new wiring) |

No new provider implementations are added. `OidcBrowserProvider` already exists in `@mcp-abap-adt/auth-providers` and supports PKCE without a client secret.

### Storage (no schema change)

Reuse existing `BTP_*` env vars from `@mcp-abap-adt/auth-stores/utils/constants`:

| Field | Env var |
|---|---|
| ABAP system URL | `BTP_ABAP_URL` |
| IdP (XSUAA tenant) URL | `BTP_UAA_URL` |
| Client ID | `BTP_UAA_CLIENT_ID` |
| Client secret | `BTP_UAA_CLIENT_SECRET` (empty for PKCE) |
| Access token | `BTP_JWT_TOKEN` |
| Refresh token | `BTP_REFRESH_TOKEN` |

`XsuaaSessionStore` (alias `BtpSessionStore`) is reused unchanged. Migration path: existing service-key `.env` files keep working; new `--url` invocations produce the same shape with an empty secret.

### Refresh

Standard XSUAA refresh-token grant against `${BTP_UAA_URL}/oauth/token`, sending `client_id` only (no secret). When XSUAA does not issue a refresh token (depends on client registration), refresh failure is treated identically to expired refresh: the broker re-runs the browser flow, unless `noBrowser` is set.

### `noBrowser` policy

`AuthBrokerConfig.noBrowser?: boolean` (default `false`).

- `false` (CLI / desktop): on refresh failure, re-launch `OidcBrowserProvider`.
- `true` (server `proxy` deployments): on refresh failure, throw a typed error; consumer surfaces a user-actionable message ("re-run `mcp-auth --url …`").

### CLI (`bin/mcp-auth.ts`)

New invocation:

```
mcp-auth --url <abap-url> --client-id <id> [--idp-url <url>] [--port <n>] --output ./mcp.env
```

Behavior:

1. `--url` and `--service-key` are mutually exclusive.
2. If `--idp-url` is omitted, attempt auto-discovery: `GET <abap-url>/ui`, regex out a `*.authentication.*.hana.ondemand.com` host. On failure, exit with a message instructing the user to pass `--idp-url` explicitly. Scrape is convenience only — the explicit override is the contract.
3. Run `OidcBrowserProvider` with PKCE S256, `redirect_uri=http://localhost:<port>/callback` (random free port if `--port` omitted), `scope=openid`.
4. On success, write `BTP_*` env vars to `--output` with `BTP_UAA_CLIENT_SECRET=` (empty).

Out of scope for this iteration:
- Custom `--scope` (defaults to `openid`; XSUAA inherits required scopes via the foreign-scope reference baked into the `client_id`).
- Configurable PKCE method (always `S256`).

### Consumer integration (`mcp-abap-adt`, `mcp-abap-adt-proxy`)

No code changes. Both already obtain tokens through `AuthBroker.createTokenRefresher()`. They opt into `noBrowser=true` for server-side deployments via existing config plumbing (proxy server only).

Documentation update only:
- README of broker: add `--url` example.
- README of proxy: note that `url-pkce` sessions in headless server mode require periodic re-authentication via CLI.

## Component Inventory

| Component | Change |
|---|---|
| `@mcp-abap-adt/auth-stores` | none |
| `@mcp-abap-adt/auth-providers` | none |
| `@mcp-abap-adt/auth-broker` (`AuthBroker.ts`) | provider-selection branch; `noBrowser` config |
| `bin/mcp-auth.ts` | new `--url` mode + `/ui` scrape fallback |
| `mcp-abap-adt` | docs only |
| `mcp-abap-adt-proxy` | docs only |

## Testing

Integration test harness (`src/__tests__/`) is real-implementation, sequential. Add:

- Unit: `AuthBroker` provider-selection logic (secret present vs absent).
- Unit: CLI argument parsing for `--url` mode (mutually exclusive flags, missing required combos).
- Unit: `/ui` scrape regex against captured fixture HTML.
- Integration (manual, gated like Test 2): `mcp-auth --url <real> --client-id <real>` end-to-end against the probed system, asserting `.env` is written with non-empty `BTP_JWT_TOKEN`.

## Open Risks

- `/ui` scrape is fragile (HTML can change). Mitigation: explicit `--idp-url` override is supported; scrape failure produces a clear actionable error.
- Refresh-token absence is client-registration dependent. Mitigation: graceful re-auth with browser, or typed error in `noBrowser` mode.
- The probed `client_id` accepted `localhost` redirect at the `/authorize` step but full end-to-end PKCE has not yet been executed against this target. Final validation happens during implementation.
