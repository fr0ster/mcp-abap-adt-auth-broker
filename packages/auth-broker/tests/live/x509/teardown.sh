#!/usr/bin/env bash
# Deletes what setup.sh recorded in .local/owned — nothing else — key before
# instance, crossing each off as it goes. A resource is deleted only if its
# current ID still matches the record; one whose name now belongs to another
# resource is left alone and crossed off, since ours is already gone.
# On the first failure it stops with a non-zero status and keeps .local/ (the
# key and the record), so running it again finishes the job. Only when
# nothing is left does it remove .local/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib.sh"
guard_target
guard_ledger

if [ -z "$(ledger_entries)" ]; then
  echo "Nothing recorded as owned; nothing to delete."
  rm -rf "$LOCAL"
  exit 0
fi

fail() {
  echo "teardown stopped: $1 — $LOCAL is kept; run tests/live/x509/teardown.sh again" >&2
  exit 1
}

# A key is ours only while both its instance and its own GUID are. The key
# goes before its instance: cf refuses to delete an instance that still has one.
delete_key() { # instance key
  recorded="$(recorded_id key "$1/$2")"
  [ -n "$recorded" ] || return 0
  instance="$(recorded_id instance "$1")"
  current_instance="$(instance_guid "$1")" || fail "could not look up $1"
  if [ -z "$instance" ] || [ "$current_instance" != "$instance" ]; then
    # Our instance is gone, and every key of it with it.
    echo "$1/$2: already gone with $1"
  else
    current="$(key_guid "$instance" "$2")" || fail "could not look up $1/$2"
    if [ -z "$current" ]; then
      echo "$1/$2: already gone"
    elif [ "$current" != "$recorded" ]; then
      echo "$1/$2: now $current, not ours ($recorded) — left alone" >&2
    else
      quietly bounded cf delete-service-key "$1" "$2" -f --wait || fail "could not delete $1/$2"
      echo "$1/$2: deleted ($recorded)"
    fi
  fi
  disown key "$1/$2"
}

delete_instance() { # name
  recorded="$(recorded_id instance "$1")"
  [ -n "$recorded" ] || return 0
  current="$(instance_guid "$1")" || fail "could not look up $1"
  if [ -z "$current" ]; then
    echo "$1: already gone"
  elif [ "$current" != "$recorded" ]; then
    echo "$1: now $current, not ours ($recorded) — left alone" >&2
  else
    quietly bounded cf delete-service "$1" -f --wait || fail "could not delete $1 (a service key not recorded as ours blocks it? cf service-keys $1 lists them; one you know is a leftover of these tests: cf delete-service-key $1 <key> -f)"
    echo "$1: deleted ($recorded)"
  fi
  disown instance "$1"
}

delete_key "$INSTANCE" "$X509_KEY"
delete_instance "$INSTANCE"

if [ -n "$(ledger_entries)" ]; then
  fail "still recorded as owned: $(ledger_entries | tr '\n' ' ')"
fi
rm -rf "$LOCAL"
