# auth-broker 5.0.0 and auth-broker-cli 3.0.0 on the 6.0.0 chain — goal

The spec and the plan answer this file. If either needs to depart from
anything under *Holds throughout*, this file changes first.

## Goal

The broker and its CLI stand on the auth chain as it is now published:
auth-providers 6.0.0, auth-stores 4.0.0, interfaces-auth 7.5.0 and
auth-errors 2.1.1. Whatever 6.0.0 guarantees a holder of a provider reaches
the broker's consumer intact, through the broker. Whatever 6.0.0 leaves to the
consumer, the broker either decides as a consumer of the providers, in the
open, or hands up to its own consumer. It never hides it and never guesses it.

**Success:**
- **Failures reach the consumer as the provider made them.** Every failure a
  provider produces gets to the broker's consumer as the same
  `AuthProviderFailure`: the same kind, facts, words and diagnostics. The
  broker's own configuration errors carry the provider's error instead of
  copying its words. Nothing in the broker or the CLI matches on words or uses
  `instanceof`; a failure from another installed copy of auth-errors is read
  the same way.
- **Renewal is chosen.** How a destination's provider renews — refresh, log
  in, how often, when to give up — is a strategy the broker's consumer
  chooses. The broker invents none and passes it to the providers it builds.
- **Session writes follow the refresh state.**
  - Tokens reach the session store through a persistence strategy.
  - A refresh token that renewal discarded never comes back from the store:
    not on the next read, not after a restart.
  - A write that failed is not lost while the process lives, and does not
    overwrite a newer one.
- **The consumer decides what a failed write means.**
  - It can choose that a call fails when a write it needs has not landed. Then
    no call reports success while that write is outstanding, and a discarded
    refresh token cannot outlive a restart unnoticed.
  - It can choose best effort. Then the restart guarantees above hold for every
    write that landed, and the documentation says so.
- **Every wait can be cancelled by whoever waits.**
  - **Calls:** `getProvider`, `getToken` and `refreshToken` each take a
    cancellation signal.
  - **One caller giving up never ends another's wait.** Callers waiting on the
    same destination share one build; when one cancels, only its own wait ends.
  - **Nothing is kept alive by callers that left.** A login started for
    callers who have all gone does not keep running.
  - **No bounds of its own.** The broker adds no timeout or bound.
- **The CLI ends a login only when the user does.** It sets no time limit. The
  user ends a login with Ctrl+C or a termination signal, and the port is
  released.
- **The CLI reaches what 6.0.0 offers:**
  - a browser chosen as an `IBrowser`;
  - the composed interactive logins;
  - `state` and PKCE on every login a provider supports;
  - a manual SAML login that always declares its ACS.
- **Debug output is opt-in and safe.** The provider's debug line comes on only
  through an explicit option or flag, and never from the environment. Without
  it, no line carries a secret or server text. With it, only that debug line
  carries the secrets it names, in the provider's prepared form, and it never
  carries server text.
- **The CLI still writes the credentials it exists to write.** The `.env` or
  JSON file a user asks the CLI for still holds the tokens and keys that file
  is for, written only where the user named it.
- **Both packages install from the registry alone.** Each is released and
  installs with every dependency resolved from npm; the broker is published
  first, then the CLI.

## Why

The broker and the CLI still build on auth-providers 5.x and interfaces-auth
3, which no current package of the chain accepts any more. The server
`mcp-abap-adt` reaches authentication only through the broker. Until the broker
moves, none of 6.0.0's guarantees reach a user of the server:
- **no error contract:** failures still arrive as 5.x error classes;
- **no login CSRF protection:** no `state`, no PKCE, no `Host` check;
- **no cancellation:** a login cannot be cancelled by the request that started
  it;
- **no renewal choice:** renewal and persistence cannot be chosen;
- **no safe debug output.**

The CLI also still sets a five-minute login limit and passes browsers by
name. Both contradict the chain's decisions.

## Holds throughout

1. **The consumer composes; nobody guesses.** The broker is a consumer of the
   providers. Each choice it makes for them is made explicitly, in its own
   configuration or code, never as a hidden default or a heuristic. Each
   choice that belongs to the broker's own consumer is that consumer's.
2. **Nothing goes out that should not.**
   - **Not in logs, errors or terminal output.** No secret, server text,
     authorization URL or `state` appears in a log line, an error, a
     diagnostic, or what the CLI prints to the terminal.
   - **Only through the provider's own debug channel:** a secret appears there
     only when the debug option is on, never otherwise.
   - **Only where the user asked for it:** credentials leave the CLI only in the
     output file the user asked for.
   - **Never re-exposed by the broker:** what the providers already keep out
     stays out.
   - **Stdout:** neither package writes anything to stdout that a stdio
     transport would read as protocol.
3. **A credential stays bound to the identity it was obtained for.** A token,
   refresh token or session is used only for the destination means it was
   obtained under: resource, SAP client, issuer and client. This holds across
   cached providers, separate store reads and delayed or retried writes. A
   credential is never reused after the means change, and a late write never
   files a credential under an identity other than the one it was obtained
   with.
4. **No built-in timeouts.** A wait ends with a result, an explicit error or
   its owner's cancellation signal.
5. **One implementation of each rule.** What auth-errors or auth-providers
   already ship — sharing a build between waiters, reading a failure, the
   refresh state — the broker uses rather than re-implements.
6. **Whoever holds an instance holds its rights.** The broker protects what it
   emits itself. It does not police what its own consumer does with a
   provider or secret that consumer holds.
7. **Registry only.** Released packages declare only semver ranges that
   resolve on npm. The workspace link between the CLI and the broker exists
   only for development.
8. **What works today keeps working, or the migration note says what to do.**
   Every behaviour a 4.x consumer or a CLI user relies on either still works or
   is named in a migration note together with the replacement. This never
   loosens invariants 2 and 3.

## Out of scope

- The server `mcp-abap-adt` and its own bound for interactive logins.
- New grants or credentials beyond what auth-providers 6.0.0 ships.
- Passwordless HTTP login (SPNego) and client certificates beyond what
  already works.
- Changes to auth-providers, auth-stores, connection or the interface
  packages. A defect found there goes to its own repository.

## Open — for the spec

1. Where the renewal strategy and the persistence choice live: in
   `AuthBrokerConfig`, per destination, or both. What a consumer that gives
   neither gets, and whether that is a refusal.
2. The refresh state of a destination across session writes, failed writes,
   retries and restarts on auth-stores 4.0.0, where `refreshToken: ''` clears.
   How this relates to `refreshStatePersistence`, and how the consumer states
   its choice about failed writes.
3. The cancellation model:
   - what a signal on `getProvider` attaches to the provider it returns;
   - how the token API reaches a provider without keeping a session alive;
   - what a cached provider does after every caller has gone.
4. The CLI's browser option: how a user names a browser on each platform,
   and how that becomes an `IBrowser`.
5. The broker's own configuration errors: their shape, and what of the
   provider's error they carry.
6. The CLI's debug flag and the broker option behind it.
7. Versions, the order of release, and the migration notes for 4.x consumers
   and CLI 2.x users.
