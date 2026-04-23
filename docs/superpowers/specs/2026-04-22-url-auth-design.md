# URL-based PKCE Bootstrap for MCP ABAP ADT Auth Broker

**Status:** Draft (revision 2 — incorporates review)
**Date:** 2026-04-22
**Branch:** `feat/url-pkce-auth`

## Problem

The auth broker today bootstraps a session from a BTP service key (JSON). Users who do not have access to download a service key — but who do have the ABAP system URL and an XSUAA `client_id` registered with `localhost` redirect and a foreign-scope reference to the ABAP system's `xsappname` — cannot use the broker.

A "URL-only with no client_id" mode was investigated and ruled out: BTP ABAP systems require a registered OAuth2 client (no anonymous token issuance). Eclipse's apparent "URL-only" flow on Steampunk reduces to Basic Auth with user/password. Basic Auth has no token lifecycle and therefore is not in scope for the broker — consumers handle it directly when needed.

## Goal

Add a second **token-bootstrap path** to the broker pipeline: **ABAP URL + client_id → browser-based authorization code with PKCE → JWT**. The existing service-key flow stays unchanged. The transport/protocol used by consumers (`mcp-abap-adt`, `mcp-abap-adt-proxy`) does not change — only the way the initial session is acquired and persisted.

OIDC discovery on the ABAP host itself is **not** a requirement. The flow is browser-based authorization code with PKCE against the ABAP system's backing authorization server (XSUAA tenant); we just need to discover or be told that authorization-server URL.

## Probe Findings (real BTP ABAP target)

Validated against `https://b0c732e4-462a-4cad-b1f3-f27c37cc2dbf.abap.eu10.hana.ondemand.com`:

- ABAP host: no OIDC discovery, no anonymous OAuth2; `/sap/bc/adt/*` returns `WWW-Authenticate: Basic`.
- The `abap-web` router redirects `/ui` to an XSUAA tenant; the tenant URL is embedded in the rendered HTML.
- XSUAA tenant (`https://esup-idp-sandbox-6iwr9oqc.authentication.eu10.hana.ondemand.com`) exposes full OIDC discovery, supports PKCE `S256`, does **not** expose `device_code` grant.
- With user-supplied `client_id` `sb-xs-...!b614777|xsuaa-abapcp-prod-eu10!b4584`:
  - `/oauth/authorize` accepts `redirect_uri=http://localhost:8765/callback` and PKCE `S256` and proceeds to login (no `invalid_redirect_uri` / `invalid_client`).
  - The foreign-scope suffix `|xsuaa-abapcp-prod-eu10!b4584` ensures issued JWTs carry the audience the ABAP system expects.

End-to-end PKCE has not yet been executed against this target; final validation happens during implementation.

## Architecture

### Reuse the existing SSO/OIDC stack

The repository already ships `bin/mcp-sso.ts` plus `SsoProviderFactory` and `OidcBrowserProvider`. The PKCE browser flow we need is `mcp-sso oidc --flow browser --issuer <xsuaa-url> --client-id <id>` — it already exists. The new feature is therefore primarily about:

1. Convenience: deriving the authorization-server URL from an ABAP system URL (so the user does not have to look it up).
2. Plumbing: ensuring the persisted session shape is consumable by `AuthBroker` without a client secret on subsequent runs (refresh).

We do **not** duplicate authorize-URL construction, callback handling, or token exchange in a second CLI.

### CLI surface

`bin/mcp-auth.ts` gets one new mode:

```
mcp-auth --url <abap-url> --client-id <id> [--idp-url <url>] [--port <n>] --output ./mcp.env
```

Behavior:

1. `--url` and `--service-key` are mutually exclusive.
2. If `--idp-url` is omitted: attempt auto-discovery by `GET <abap-url>/ui` and regex-extract a `*.authentication.*.hana.ondemand.com` host. On failure, exit with a clear actionable error pointing at `--idp-url`. The scrape is convenience only; the explicit override is the contract.
3. Internally delegate the actual authorization-code + PKCE flow to the same code path used by `mcp-sso oidc --flow browser`. `mcp-auth --url` is a thin wrapper that resolves arguments and calls into the shared SSO/OIDC plumbing.
4. On success, write env vars to `--output` consistent with what the broker reads on subsequent runs (see Storage).

Out of scope for this iteration:
- Custom `--scope` (defaults to `openid`; XSUAA inherits required scopes via the foreign-scope reference baked into `client_id`).
- Configurable PKCE method (always `S256`).
- Adding a parallel CLI; if `mcp-sso` already exposes everything except the ABAP-URL discovery convenience, an alternative is to add `--abap-url` to `mcp-sso` instead. The implementation plan picks one.

### Storage

Reuse existing `BTP_*` env vars from `@mcp-abap-adt/auth-stores/utils/constants`:

| Field | Env var |
|---|---|
| ABAP system URL | `BTP_ABAP_URL` |
| IdP (XSUAA tenant) URL | `BTP_UAA_URL` |
| Client ID | `BTP_UAA_CLIENT_ID` |
| Client secret | `BTP_UAA_CLIENT_SECRET` |
| Access token | `BTP_JWT_TOKEN` |
| Refresh token | `BTP_REFRESH_TOKEN` |

Schema is unchanged. PKCE/public-client sessions:

- **Exported `.env`:** `BTP_UAA_CLIENT_SECRET=` (empty) or omitted entirely. The CLI prefers omission when the underlying writer supports it; empty string is the fallback.
- **Internal session representation:** if the broker, store, or provider currently treats "no secret" as malformed (e.g., constructor validation), the implementation may use a sentinel marker internally and strip it on export. The implementation plan validates this against the actual code paths.

### Bootstrap vs runtime selection in `AuthBroker`

The current `AuthBroker` is constructed with a single `tokenProvider` instance and does not dynamically instantiate providers from persisted session state. Treating PKCE as a bootstrap-only concern (via the CLI) is therefore the path of least architectural change.

Two scoping options:

- **A (preferred for this iteration):** keep provider selection out of `AuthBroker`. The bootstrap CLI produces an `.env` whose contents are loaded by an existing provider that happens to work without a secret (`OidcBrowserProvider` or refresh-only equivalent). Consumers continue to construct the broker the way they do today; if the chosen provider requires the same constructor signature regardless of secret presence, no consumer code change is needed.
- **B (deferred):** introduce dynamic provider resolution inside `AuthBroker` driven by persisted state. This is a separate refactor with broader test surface and is **not** scoped here.

The implementation plan chooses A and documents what (if anything) must change in consumers to reach "no consumer code changes" honestly.

### Refresh and `allowBrowserAuth`

Refresh uses the standard XSUAA refresh-token grant against `${BTP_UAA_URL}/oauth/token`, sending `client_id` only.

Headless behavior reuses the existing `AuthBrokerConfig.allowBrowserAuth` (already implemented at `src/AuthBroker.ts:77,89,176`):

- `allowBrowserAuth: true` (default, CLI/desktop): on refresh failure, re-launch the browser flow.
- `allowBrowserAuth: false` (server proxy): on refresh failure, throw the existing typed error; consumer surfaces a user-actionable message ("re-run `mcp-auth --url …`").

No new API on the broker. No `noBrowser` flag — the existing `allowBrowserAuth` already covers it with opposite polarity.

Whether XSUAA actually issues a refresh token for a given public-client registration is registration-dependent and must be observed during implementation; the design must tolerate either outcome.

### Consumer integration

No code changes in `mcp-abap-adt` or `mcp-abap-adt-proxy` provided option A above holds. They continue to construct the broker as today; `allowBrowserAuth` is set per their existing config plumbing (proxy server keeps it `false`).

Documentation update only:
- Broker README: add `--url` example.
- Proxy README: note that PKCE-bootstrapped sessions in headless mode require periodic re-authentication via the CLI.

## Component Inventory

| Component | Change |
|---|---|
| `@mcp-abap-adt/auth-stores` | none |
| `@mcp-abap-adt/auth-providers` | none |
| `@mcp-abap-adt/auth-broker` (`AuthBroker.ts`) | none if option A holds; otherwise minimal tolerance for empty `client_secret` (validated in implementation) |
| `bin/mcp-auth.ts` | new `--url` mode that delegates to existing SSO/OIDC plumbing and adds `/ui` discovery convenience |
| `mcp-abap-adt`, `mcp-abap-adt-proxy` | docs only |

## Testing

The highest-value validation is end-to-end public-client authorization against a real ABAP cloud target, not generic OIDC support.

Required proof points (gated like the existing browser test):

- Discovered or manually supplied authorization server accepts the registered `localhost` redirect URI for the supplied `client_id`.
- Token exchange completes successfully without a client secret using PKCE `S256`.
- The resulting access token is accepted by `/sap/bc/adt/*` on the target ABAP system (a single GET that the broker's existing fixture already exercises is enough).
- Whether refresh tokens are issued for the tested client registration is observed and documented explicitly in the test report; design behavior is verified for both outcomes (refresh available → refresh path; no refresh → re-auth path under `allowBrowserAuth: true`).

Unit tests:

- CLI argument parsing for the new `--url` mode (mutually exclusive flags, missing required combos).
- `/ui` scrape regex against captured fixture HTML (happy path + a "no XSUAA URL present" negative).
- Bootstrap output: `.env` is written with `BTP_*` keys and either an empty or omitted `BTP_UAA_CLIENT_SECRET`, and is round-trippable through the existing session loader.

## Open Risks

- `/ui` scrape is fragile (HTML can change). Mitigation: explicit `--idp-url` override; scrape failure produces a clear actionable error.
- Refresh-token absence is registration-dependent. Mitigation: graceful re-auth under `allowBrowserAuth: true`, typed error otherwise. Document the observed outcome for the probed target.
- Option A assumes the existing provider stack tolerates a secret-less session without code changes in the broker. If implementation discovers it does not, the smallest-possible tolerance change in `AuthBroker`/store is added and called out in the plan; option B remains explicitly out of scope.
- End-to-end PKCE has not been executed against the probed target yet; only the `/oauth/authorize` precondition has been verified. Final acceptance happens in implementation.
