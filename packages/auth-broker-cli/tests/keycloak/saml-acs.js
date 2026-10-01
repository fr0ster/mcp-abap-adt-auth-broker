#!/usr/bin/env node

const http = require('http');
const { URLSearchParams } = require('url');

const port = Number(process.env.PORT || 3002);
const outputFile =
  process.env.SAML_OUTPUT || '/tmp/keycloak-saml-response.txt';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/acs') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  try {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const samlResponse = params.get('SAMLResponse');
    const relayState = params.get('RelayState');

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SAMLResponse received. You can close this tab.');

    if (!samlResponse) {
      console.error('SAMLResponse not found in POST body.');
      return;
    }

    try {
      require('fs').writeFileSync(outputFile, samlResponse, 'utf8');
      console.log(`SAMLResponse written to ${outputFile}`);
    } catch (error) {
      console.error('Failed to write SAMLResponse to file:', error);
    }

    console.log('');
    console.log('SAMLResponse (base64):');
    console.log(samlResponse);
    if (relayState) {
      console.log('');
      console.log('RelayState:');
      console.log(relayState);
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error');
    console.error('Failed to read SAMLResponse:', error);
  }
});

server.listen(port, () => {
  console.log(`SAML ACS listening on http://localhost:${port}/acs`);
});
