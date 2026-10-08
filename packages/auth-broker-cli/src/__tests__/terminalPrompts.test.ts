/**
 * What a terminal login shows on stderr, in order: the provider's URL prompt
 * (its lead, then the URL, each on its own line), then the CLI's question —
 * never the question with the URL's lead appended to it on one line.
 *
 * The shipped compositions arm their paste — which asks the question — before
 * the URL is presented; the CLI's reader asks only once the presentation has
 * run, so the question follows the URL on a line of its own.
 */

// A terminal that writes the question where readline writes it — stderr —
// and answers it.
jest.mock('node:readline', () => ({
  createInterface: () => {
    const onClose: Array<() => void> = [];
    return {
      on: (event: string, listener: () => void) => {
        if (event === 'close') onClose.push(listener);
      },
      question: (prompt: string, answer: (value: string) => void) => {
        process.stderr.write(prompt);
        answer('TYPED-ANSWER');
      },
      close: () => {
        for (const listener of onClose) listener();
      },
    };
  },
}));

import {
  buildPasscodeAuthorization,
  buildSamlAuthorization,
  type McpSsoOptions,
} from '../mcpSsoConfig';

let written: string[];
let spy: jest.SpyInstance;

beforeEach(() => {
  written = [];
  spy = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
});

afterEach(() => {
  spy.mockRestore();
});

/** stderr as the user saw it, one entry per line. */
const lines = () => written.join('').split('\n');

const URL_SHOWN = 'https://uaa.example/passcode';

it('the passcode: the URL prompt, then the question on its own line', async () => {
  const strategy = buildPasscodeAuthorization({
    authType: 'xsuaa',
    format: 'env',
  } as McpSsoOptions);
  const outcome = await strategy.authorize({
    buildAuthorizationUrl: async () => URL_SHOWN,
    signal: new AbortController().signal,
  });
  expect(outcome.payload).toBe('TYPED-ANSWER');
  const shown = lines();
  const lead = shown.findIndex((line) => line.includes('Open this URL'));
  const url = shown.findIndex((line) => line.includes(URL_SHOWN));
  const question = shown.findIndex((line) =>
    line.includes('Paste the Temporary Authentication Code'),
  );
  expect(lead).toBeGreaterThanOrEqual(0);
  expect([lead < url, url < question]).toEqual([true, true]);
  // The question and the lead never share a line.
  expect(shown[question]).not.toContain('Open this URL');
  expect(shown[lead]).not.toContain('Paste');
});

it('the manual SAML paste: the URL prompt, then the question on its own line', async () => {
  const strategy = buildSamlAuthorization({
    authType: 'abap',
    format: 'env',
    protocol: 'saml2',
    flow: 'pure',
    assertionFlow: 'manual',
    acsUrl: 'https://abap.example.com/sap/saml2/sp/acs/100',
  } as McpSsoOptions);
  const idpUrl = 'https://idp.example/sso?SAMLRequest=x';
  await strategy.authorize({
    buildAuthorizationUrl: async () => idpUrl,
    signal: new AbortController().signal,
  });
  const shown = lines();
  const url = shown.findIndex((line) => line.includes(idpUrl));
  const question = shown.findIndex((line) =>
    line.includes('Paste the SAMLResponse'),
  );
  expect(url).toBeGreaterThanOrEqual(0);
  expect(url < question).toBe(true);
  expect(shown[question]).not.toContain('Open this URL');
});
