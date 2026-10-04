# x509 service keys — goal and path

**Status:** draft goal, for review in this PR. The spec and then the plan come
next, in this PR. This file is the anchor: it says what they are for, and what
neither may trade away. If the spec or the plan needs to depart from anything
under *Holds throughout*, this file changes first — explicitly, in review.

## Goal

A destination whose XSUAA service key is an **x509 key** — created with
`{"credential-type": "x509"}`, carrying `certificate`, `key` and `certurl`
instead of `clientsecret` — gets a working provider from
`getProvider(destination)` and a token from the token API, exactly as a key
with a secret does today. The client authenticates with its certificate over
mTLS at `certurl`, through `tlsClientCertificate` from
`@mcp-abap-adt/auth-providers` 5.3.0.

The broker also moves to `@mcp-abap-adt/auth-providers` 5.3.0 and
`@mcp-abap-adt/interfaces-auth` 3.2.0 for every destination, x509 or not.

**Success:** on the BTP trial, an XSUAA instance with an x509 key, read by
`@mcp-abap-adt/auth-stores`' service-key store, yields a token through
`getProvider` / the token API and through the CLI (`mcp-auth`,
`generate-env-from-service-key`), with no secret anywhere; every existing
destination behaves as in 4.0.0; the default `npm test` stays offline.

## Why

`@mcp-abap-adt/auth-providers` 5.3.0 can authenticate a client with a
certificate; nothing above it can yet, because the service-key store rejects a
key without `clientsecret` and the broker only ever passes a secret. A
consumer of the broker — not `mcp-abap-adt` for now — should be able to use an
x509 key without building providers itself.

## What changes, by repository

1. **`@mcp-abap-adt/interfaces-auth-broker`** (minor, released first):
   `IServiceKeyStore` gains an optional method that answers a destination's
   client certificate — the certificate, its private key and the mTLS token
   host — or nothing; with the type it returns. `@mcp-abap-adt/interfaces-auth-sap`
   (`IAuthorizationConfig`) does not change.
2. **`@mcp-abap-adt/auth-stores`** (minor, released next): the XSUAA
   service-key store recognises an x509 key and implements that method; a key
   with a secret is read as today.
3. **`@mcp-abap-adt/auth-broker` and `auth-broker-cli`** (this PR): the
   dependency moves; the broker builds `tlsClientCertificate` for a destination
   whose store answers a certificate, and the CLI paths that build providers
   or copy a key's client do the same.
4. **`mcp-abap-adt`** — not in this task. It moves to the new versions in its
   own change and uses no certificate until an ABAP system with certificate
   logon exists to test on.

## Holds throughout

1. **A certificate and its private key stay where the consumer put them** —
   the service-key file (or what the spec decides for a destination `.env`).
   They never reach the session store, a log line, a refusal, a thrown
   message or the CLI's output.
2. **The key says what it is.** A key carrying `certificate` and `key` is an
   x509 key; one carrying `clientsecret` is a secret key. Nothing is guessed,
   and nothing falls back from one to the other.
3. **A key with a secret works exactly as today** — same store answers, same
   provider, same request.
4. **The consumer composes.** The broker builds the provider the destination
   states; it does not choose an authentication the destination does not
   state (the providers' rule 7, `provider-does-not-guess`).
5. **Dependencies only from the registry**, each released before its consumer
   builds against it.
6. **Every claim is measured.** The x509 path is proven live on the BTP trial
   (opt-in, never in the default run); what is not measured — x509 on an ABAP
   instance's key, a user grant over x509 at ADT — is written down as unproven.

## Out of scope

- Using a certificate in `mcp-abap-adt`, or any ABAP certificate logon.
- `private_key_jwt` and other client-authentication strategies in the broker.
- An ABAP environment service key with x509 (the ABAP instance's keys are
  `binding-secret` on the trial; nothing documents an x509 one).
- Rotating or issuing certificates.

## Open, for the spec

1. The method's name and shape, and whether `getConnectionConfig` / the
   destination's stated grant needs to say anything about it.
2. A destination `.env` (`EnvDestinationStore`): paths to the PEM files, the
   PEM inline, or not supported in this change.
3. Which grants take the certificate: `client_credentials` (measured) and
   `authorization_code` (the token request goes to `certurl`, the authorize
   page to `url`); `passcode` (`UaaPasscodeProvider` has no
   `clientAuthentication`) — refused, or out of scope.
4. A wrapped key (`{"credentials": {…}}`), as the CLI already unwraps.
5. Where the live check lives (broker `test:live`, a trial setup/teardown like
   auth-providers' `tests/xsuaa/`).

## Path

1. This goal → spec → plan, each reviewed in this PR.
2. interfaces-auth-broker minor: its own PR, released.
3. auth-stores minor: its own PR, released.
4. Implementation in this PR, against the published versions; live check on
   the trial; external review; merge and release on the user's word.
