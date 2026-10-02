# Test identity provider key — a TEST FIXTURE

`idp.key` and `idp.crt` are the signing key and certificate of the `test-idp`
SAML identity provider configured in `../config/uaa.yml`. The UAA suite signs
its bearer assertions with them, and UAA verifies those signatures against the
certificate in the provider's metadata.

They exist only for the local stand and are committed on purpose, like the
rest of `tests/stand/`. Nothing outside the test suites trusts them. Do not
reuse them.
