#!/usr/bin/env node

const fs = require('fs');
const zlib = require('zlib');

const issuer = process.env.SAML_SP_ENTITY_ID || 'mcp-sso-saml';
const acsUrl = process.env.SAML_ACS_URL || 'http://localhost:3002/acs';
const destination =
  process.env.SAML_IDP_URL ||
  'http://localhost:8080/realms/mcp-sso/protocol/saml';
const relayState = process.env.SAML_RELAY_STATE || '';
// The request ID, for `--authn-request-id`: the assertion answers it, and
// mcp-sso did not build this request, so it cannot know the ID otherwise.
const requestIdFile =
  process.env.SAML_REQUEST_ID_FILE || '/tmp/keycloak-saml-request-id.txt';

function buildAuthnRequest(id) {
  const issueInstant = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  ID="${id}"
  Version="2.0"
  IssueInstant="${issueInstant}"
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
  AssertionConsumerServiceURL="${acsUrl}">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer>
</samlp:AuthnRequest>`;
}

function deflateAndEncode(xml) {
  const deflated = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
  return deflated.toString('base64');
}

const id = `_${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
fs.writeFileSync(requestIdFile, id);
const xml = buildAuthnRequest(id);
const samlRequest = deflateAndEncode(xml);

const params = new URLSearchParams({ SAMLRequest: samlRequest });
if (relayState) {
  params.set('RelayState', relayState);
}

const url = `${destination}?${params.toString()}`;
process.stdout.write(url);
