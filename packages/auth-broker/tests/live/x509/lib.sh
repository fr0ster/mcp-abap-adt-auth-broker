# Shared by tests/live/x509/*.sh. Sourced, not run. Bash 3.2-compatible.
#
# Modelled on auth-providers' tests/xsuaa/lib.sh, cut to what this check needs:
# one XSUAA application instance and one x509 service key — no apiaccess
# instance, no SAML trust.
#
# These scripts create and delete real resources in a BTP subaccount. Two
# rules keep them from touching anything else:
#   - they refuse to run unless `cf` targets exactly XSUAA_CF_API,
#     XSUAA_CF_ORG and XSUAA_CF_SPACE — no defaults;
#   - they touch only what they created. Every resource setup.sh creates is
#     recorded in $LEDGER with its immutable ID — the service instance GUID
#     and the service key's GUID — and the ledger itself names the target it
#     belongs to. A resource is ours only if its name AND its current ID match
#     a record, checked right before it is reused, refreshed or deleted; a
#     ledger from another target is refused outright.
#
# Ledger format:   target <api>|<org>|<space>
#                  instance <name> <guid>
#                  key <instance>/<key> <guid>
#
# What setup.sh leaves in $LOCAL (directory 0700, every file 0600), for the
# suite (AUTH_BROKER_LIVE_X509_LOCAL):
#   keys/x509.json   the x509 service key as `cf service-key` prints it — the
#                    destination `x509` of an XsuaaServiceKeyStore over keys/
#   client.crt       its `certificate` (the PEM chain), as given
#   client.key       its `key` (the PEM private key), as given
#   owned            the ledger

INSTANCE=auth-broker-x509-test
X509_KEY=x509-key
LOCAL="$HERE/.local"
LEDGER="$LOCAL/owned"
KEYS="$LOCAL/keys"
DESTINATION=x509

guard_target() {
  if [ -z "${XSUAA_CF_API:-}" ] || [ -z "${XSUAA_CF_ORG:-}" ] || [ -z "${XSUAA_CF_SPACE:-}" ]; then
    echo "Set XSUAA_CF_API, XSUAA_CF_ORG and XSUAA_CF_SPACE to the Cloud Foundry" \
      "API, org and space to use." >&2
    exit 2
  fi
  target="$(cf target 2>/dev/null || true)"
  api="$(printf '%s\n' "$target" | sed -n 's/^API endpoint: *//p')"
  org="$(printf '%s\n' "$target" | sed -n 's/^org: *//p')"
  space="$(printf '%s\n' "$target" | sed -n 's/^space: *//p')"
  if [ "$api" != "$XSUAA_CF_API" ] || [ "$org" != "$XSUAA_CF_ORG" ] || [ "$space" != "$XSUAA_CF_SPACE" ]; then
    echo "Refusing: cf targets '$api' / '$org' / '$space'," \
      "not '$XSUAA_CF_API' / '$XSUAA_CF_ORG' / '$XSUAA_CF_SPACE'." >&2
    echo "Run: cf login -a $XSUAA_CF_API --sso -o $XSUAA_CF_ORG -s $XSUAA_CF_SPACE" >&2
    exit 2
  fi
  TARGET="$api|$org|$space"
}

# A ledger written for another target must never be acted on here.
guard_ledger() {
  if [ -f "$LEDGER" ]; then
    recorded="$(sed -n '1s/^target //p' "$LEDGER")"
    if [ "$recorded" != "$TARGET" ]; then
      echo "Refusing: $LEDGER records resources of '$recorded', not '$TARGET'." >&2
      echo "Switch cf back to that target to tear them down." >&2
      exit 2
    fi
  fi
}

start_ledger() {
  mkdir -p "$LOCAL"
  chmod 700 "$LOCAL"
  [ -f "$LEDGER" ] || printf 'target %s\n' "$TARGET" > "$LEDGER"
}

recorded_id() { # kind name
  [ -f "$LEDGER" ] || return 0
  awk -v k="$1" -v n="$2" '$1 == k && $2 == n { print $3 }' "$LEDGER"
}

own() { # kind name id
  disown "$1" "$2"
  printf '%s %s %s\n' "$1" "$2" "$3" >> "$LEDGER"
}

disown() { # kind name
  if [ -f "$LEDGER" ]; then
    awk -v k="$1" -v n="$2" '!($1 == k && $2 == n)' "$LEDGER" > "$LEDGER.tmp"
    mv "$LEDGER.tmp" "$LEDGER"
  fi
}

# Records other than the target line.
ledger_entries() {
  [ -f "$LEDGER" ] && sed -n '2,$p' "$LEDGER" || true
}

# Prints the instance's GUID, or nothing when cf confirms there is no such
# instance. Any other outcome — no session, no network, an API error — fails:
# `cf service` exits 1 for "not found" and for errors alike, so only its exact
# not-found message counts as absence. Callers must stop on that failure
# rather than read an empty result as "gone".
instance_guid() { # name
  if out="$(cf service "$1" --guid 2>&1)"; then
    if printf '%s\n' "$out" | grep -qE '^[0-9a-f-]{36}$'; then
      printf '%s\n' "$out" | grep -E '^[0-9a-f-]{36}$'
      return 0
    fi
  elif printf '%s\n' "$out" | grep -qxF "Service instance '$1' not found"; then
    return 0
  fi
  echo "could not look up service instance $1: $(printf '%s' "$out" | head -1)" >&2
  return 3
}

# Prints the GUID of the service key <key> of the instance <instance-guid>,
# or nothing when the Cloud Controller lists no such key. Asked through the v3
# API rather than `cf service-key --guid`, so absence is an empty list, not a
# message to match: any answer that is not a list — no session, no network,
# an API error — fails, and so does a listed key that is not the one asked
# for (another name, another instance, no GUID). Callers must stop on that
# failure rather than read it as "gone".
key_guid() { # instance-guid key
  out="$(cf curl "/v3/service_credential_bindings?type=key&service_instance_guids=$1&names=$2" 2>&1)" || {
    echo "could not look up service key $2: $(printf '%s' "$out" | head -1)" >&2
    return 3
  }
  printf '%s' "$out" | node -e '
    const [instance, name] = process.argv.slice(1);
    const fail = (why) => {
      console.error(`could not look up service key ${name}: ${why}`);
      process.exit(3);
    };
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      if (!body || !Array.isArray(body.resources)) fail("not a listing");
      if (body.resources.length > 1) fail(`${body.resources.length} listed, expected one`);
      if (body.resources.length === 0) return;
      const [key] = body.resources;
      if (key.name !== name) fail("the listed key has another name");
      if (key.relationships?.service_instance?.data?.guid !== instance)
        fail("the listed key belongs to another instance");
      if (typeof key.guid !== "string" || key.guid === "") fail("the listed key has no GUID");
      console.log(key.guid);
    });
  ' "$1" "$2"
}

# How long one `cf … --wait` may take, in seconds, before it counts as a
# failure (a broker that never answers must not hang the run). The caller
# treats a timeout like any other failure: it looks up what exists and records
# what it created.
CF_WAIT_TIMEOUT="${CF_WAIT_TIMEOUT:-600}"

# Runs a command bounded by CF_WAIT_TIMEOUT, through GNU `timeout` (`gtimeout`
# from Homebrew coreutils on macOS). Without either it runs unbounded and
# says so: macOS ships neither.
bounded() { # command...
  if command -v timeout >/dev/null 2>&1; then
    timeout "$CF_WAIT_TIMEOUT" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$CF_WAIT_TIMEOUT" "$@"
  else
    echo "note: no timeout command; $1 $2 runs unbounded" >&2
    "$@"
  fi
}

# Runs a cf command that prints no secret, showing its output only when it
# fails — cf writes the reason to stdout as often as to stderr.
quietly() { # command...
  if ! out="$("$@" 2>&1)"; then
    printf '%s\n' "$out" >&2
    return 1
  fi
}

# `cf service-key` prints a header before the JSON. The file is created
# readable by its owner only, before anything is written to it: the key holds
# a private key, and never reaches the terminal.
save_key() { # instance key file
  rm -f "$3"
  (umask 077 && cf service-key "$1" "$2" 2>/dev/null | sed -n '/^{/,$p' > "$3")
  [ -s "$3" ]
}

# Writes the key's `certificate` and `key` as given — no line ending or chain
# normalised — into client.crt and client.key, owner-only, created before a
# byte is written. Nothing of the key reaches the terminal: a missing field or
# unreadable JSON is reported in fixed words, never with the parser's message,
# which would quote the file.
write_pem_fixtures() { # key-file out-dir
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [file, dir] = process.argv.slice(1);
    let key;
    try { key = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
      console.error("the x509 service key is not JSON");
      process.exit(1);
    }
    const c = key && typeof key.credentials === "object" ? key.credentials : key;
    const missing = ["url", "clientid", "certurl", "certificate", "key"]
      .filter((f) => typeof c?.[f] !== "string" || c[f] === "");
    if (missing.length) {
      console.error(`the x509 service key lacks ${missing.join(", ")}`);
      process.exit(1);
    }
    for (const [name, value] of [["client.crt", c.certificate], ["client.key", c.key]]) {
      const target = path.join(dir, name);
      fs.rmSync(target, { force: true });
      fs.writeFileSync(target, value, { mode: 0o600, flag: "wx" });
    }
  ' "$1" "$2"
}
