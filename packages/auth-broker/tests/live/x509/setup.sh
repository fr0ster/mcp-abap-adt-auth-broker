#!/usr/bin/env bash
# Creates the x509 live check's environment in the targeted space:
#   - an xsuaa/application instance whose client may use client_credentials
#     and authenticate with a secret or a client certificate (credential-types
#     binding-secret, x509 — the pair measured on the trial, 2026-10-04, in
#     auth-providers' tests/xsuaa);
#   - its service key `x509-key`, created with {"credential-type":"x509"},
#     holding a certificate and its private key. It is created afresh on every
#     run — XSUAA's certificate is valid for about seven days.
# The key is saved owner-only to .local/keys/x509.json, and its certificate
# and private key, as given, to .local/client.crt and .local/client.key — the
# PEM files the CLI's --cert-path / --key-path name. Nothing of the key is
# printed.
#
# Everything it creates is recorded, with its ID, in .local/owned. A resource
# with one of these names whose ID is not recorded there is someone else's:
# it refuses. Re-running reuses only what it owns. Undo with teardown.sh.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
guard_target
guard_ledger

refuse_foreign() { # description
  echo "Refusing: $1 exists but is not recorded as ours in $LEDGER." \
    "Remove or rename it, or run elsewhere." >&2
  exit 2
}

# Check the instance and its key before creating anything, so a collision
# leaves nothing half-built behind.
guid="$(instance_guid "$INSTANCE")" || exit 3
if [ -n "$guid" ]; then
  [ "$guid" = "$(recorded_id instance "$INSTANCE")" ] \
    || refuse_foreign "service instance $INSTANCE ($guid)"
  # On an instance of ours, a key with our name that we did not record is
  # someone else's.
  key="$(key_guid "$guid" "$X509_KEY")" || exit 3
  if [ -n "$key" ] && [ "$key" != "$(recorded_id key "$INSTANCE/$X509_KEY")" ]; then
    refuse_foreign "service key $INSTANCE/$X509_KEY ($key)"
  fi
fi

start_ledger

ensure_instance() { # name plan params-file
  guid="$(instance_guid "$1")" || exit 3
  if [ -n "$guid" ]; then
    [ "$guid" = "$(recorded_id instance "$1")" ] || refuse_foreign "service instance $1 ($guid)"
    # An instance kept from an earlier run (X509_KEEP=1) gets today's
    # parameters: credential types and grant types may have changed since.
    quietly bounded cf update-service "$1" -c "$3" --wait || {
      echo "$1: could not update it with $3" >&2
      exit 1
    }
    echo "$1: reused (owned, $guid)"
  else
    # Recorded right after it is created — and also when cf reports the
    # create failed or timed out, if the instance is there anyway: the name
    # was free a moment ago (checked above), so it is the one this run asked
    # for. Unrecorded, teardown would leave it and every later run would
    # refuse it as someone else's.
    created=1
    quietly bounded cf create-service xsuaa "$2" "$1" -c "$3" --wait || created=0
    guid="$(instance_guid "$1")" || {
      echo "$1: could not tell whether it was created, so it is not recorded." \
        "If cf services lists it, remove it: cf delete-service $1 -f" >&2
      exit 3
    }
    if [ -n "$guid" ]; then
      own instance "$1" "$guid"
      echo "$1: created ($guid)"
    fi
    [ "$created" = 1 ] || { echo "$1: could not create it" >&2; exit 1; }
    [ -n "$guid" ] || { echo "$1: created, but cf reports it absent" >&2; exit 1; }
  fi
}

# Makes sure the instance's key exists, freshly created, and is recorded as
# ours: an owned key is deleted and created again. A key is recorded right
# after it is created — and also when cf reports the create failed, if the
# key is there anyway: it was absent a moment ago, on an instance of ours, so
# it is the one this run asked for. Unrecorded, it would block every later run.
fresh_key() { # instance key key-params
  instance="$(recorded_id instance "$1")"
  [ -n "$instance" ] || { echo "$1: not recorded as ours; no key made" >&2; exit 1; }
  key="$(key_guid "$instance" "$2")" || exit 3
  if [ -n "$key" ]; then
    [ "$key" = "$(recorded_id key "$1/$2")" ] || refuse_foreign "service key $1/$2 ($key)"
    quietly bounded cf delete-service-key "$1" "$2" -f --wait || {
      echo "$1/$2: could not delete it to create it afresh" >&2
      exit 1
    }
    disown key "$1/$2"
    echo "$1/$2: deleted ($key), to be created afresh"
  fi
  created=1
  quietly bounded cf create-service-key "$1" "$2" -c "$3" --wait || created=0
  key="$(key_guid "$instance" "$2")" || {
    echo "$1/$2: could not tell whether it was created, so it is not recorded." \
      "If cf service-keys $1 lists it, remove it: cf delete-service-key $1 $2 -f" >&2
    exit 3
  }
  if [ -n "$key" ]; then
    own key "$1/$2" "$key"
    echo "$1/$2: created ($key)"
  fi
  [ "$created" = 1 ] || { echo "$1/$2: could not create it" >&2; exit 1; }
  [ -n "$key" ] || { echo "$1/$2: created, but cf reports it absent" >&2; exit 1; }
}

# The target once more, right before the first write: cf may have been
# pointed elsewhere since the run started.
guard_target
guard_ledger
ensure_instance "$INSTANCE" application "$HERE/xs-security.json"

# The files of an earlier run go first: a run that fails below must not leave
# the suite an old key and its expired certificate.
rm -rf "$KEYS"
rm -f "$LOCAL/client.crt" "$LOCAL/client.key"
fresh_key "$INSTANCE" "$X509_KEY" '{"credential-type":"x509"}'
(umask 077 && mkdir -p "$KEYS")
chmod 700 "$KEYS"
save_key "$INSTANCE" "$X509_KEY" "$KEYS/$DESTINATION.json" || {
  echo "$INSTANCE/$X509_KEY: could not save it" >&2
  exit 1
}
write_pem_fixtures "$KEYS/$DESTINATION.json" "$LOCAL"
echo "x509 key saved to $KEYS/$DESTINATION.json; PEM fixtures in $LOCAL (owner-only)"
