/**
 * The `generate-env` development script: the grant is a flag, never read from
 * the service key — 3.x took `client_credentials` from an XSUAA key's URL
 * and `authorization_code` from anything else. What it writes is a destination
 * the broker builds from, with the secret alone in the session.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { staticCodeStrategy } from '@mcp-abap-adt/auth-providers';
import {
  AbapSessionStore,
  EnvDestinationStore,
  XSUAA_DESTINATION_VARS,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import { runGenerateEnv } from '../generateEnv';
import {
  jwtName,
  type LocalServer,
  startLocalServer,
  tokenAnswer,
} from './helpers/localServer';

let server: LocalServer;
let root: string;
let spies: jest.SpyInstance[];

beforeEach(async () => {
  server = await startLocalServer();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-env-'));
  spies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** An XSUAA key — the shape 3.x read as client_credentials. */
function xsuaaKey(): string {
  const file = path.join(root, 'mcp.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      url: `${server.url}/authentication`,
      clientid: 'key-client',
      clientsecret: 'key-secret',
    }),
  );
  return file;
}

function abapKey(): string {
  const file = path.join(root, 'TRIAL.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      uaa: {
        url: server.url,
        clientid: 'key-client',
        clientsecret: 'key-secret',
      },
      abap: { url: 'https://abap.example.com' },
    }),
  );
  return file;
}

let workDir: string;
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(root, 'work-'));
});

const noBrowser = {
  authorization: () => staticCodeStrategy({ payload: 'the-code' }),
  get workDir() {
    return workDir;
  },
};

describe('generate-env', () => {
  it.each([
    ['an XSUAA key', 'mcp', xsuaaKey],
    ['an ABAP key', 'TRIAL', abapKey],
  ])(
    'without --grant, refuses %s: nothing inferred, nothing written',
    async (_, name, key) => {
      const session = path.join(root, 'sessions', `${name}.env`);
      await expect(
        runGenerateEnv([name, key(), session], noBrowser),
      ).resolves.toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--grant is required'),
      );
      expect(server.requests).toHaveLength(0);
      expect(fs.existsSync(session)).toBe(false);
    },
  );

  it('refuses a grant a service key client does not serve alone', async () => {
    await expect(
      runGenerateEnv(['mcp', xsuaaKey(), '--grant', 'password'], noBrowser),
    ).resolves.toBe(1);
    expect(server.requests).toHaveLength(0);
  });

  it('writes the grant the flag states — authorization_code for an XSUAA key too', async () => {
    server.answer('/authentication/oauth/token', tokenAnswer('gen'));
    const session = path.join(root, 'sessions', 'mcp.env');
    await expect(
      runGenerateEnv(
        ['mcp', xsuaaKey(), session, '--grant', 'authorization_code'],
        noBrowser,
      ),
    ).resolves.toBe(0);
    expect(server.requests[0].form.grant_type).toBe('authorization_code');
    const dir = path.dirname(session);
    const means = await new EnvDestinationStore(dir, {
      variables: XSUAA_DESTINATION_VARS,
    }).getConnectionConfig('mcp');
    expect(means).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'authorization_code',
      }),
    );
    const secret = await new XsuaaSessionStore(dir).loadSession('mcp');
    expect(jwtName(secret?.authorizationToken)).toBe('gen-access-1');
  });

  it('writes client_credentials for an ABAP key when the flag says so', async () => {
    server.answer('/oauth/token', tokenAnswer('cc', false));
    const session = path.join(root, 'sessions', 'TRIAL.env');
    await expect(
      runGenerateEnv(
        ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
        noBrowser,
      ),
    ).resolves.toBe(0);
    expect(server.requests[0].form.grant_type).toBe('client_credentials');
    const dir = path.dirname(session);
    expect(
      await new EnvDestinationStore(dir).getConnectionConfig('TRIAL'),
    ).toEqual(
      expect.objectContaining({
        authType: 'jwt',
        grantType: 'client_credentials',
        serviceUrl: 'https://abap.example.com',
      }),
    );
  });

  it('a secret the store does not take fails the run (flush)', async () => {
    server.answer('/oauth/token', tokenAnswer('cc', false));
    const spy = jest
      .spyOn(AbapSessionStore.prototype, 'saveSession')
      .mockRejectedValue(new Error('disk full'));
    try {
      await expect(
        runGenerateEnv(
          [
            'TRIAL',
            abapKey(),
            path.join(root, 'sessions', 'TRIAL.env'),
            '--grant',
            'client_credentials',
          ],
          noBrowser,
        ),
      ).resolves.toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(server.requests).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('The session was not stored'),
    );
  });

  describe('the session file is changed only once the secret is stored', () => {
    const before = [
      'SAP_URL=https://old.example.com',
      'SAP_AUTH_TYPE=jwt',
      'SAP_GRANT_TYPE=password',
      'SAP_USERNAME=alice',
      "SAP_PASSWORD='old-password'",
      'SAP_JWT_TOKEN=old-token',
      '',
    ].join('\n');
    let session: string;
    beforeEach(() => {
      session = path.join(root, 'sessions', 'TRIAL.env');
      fs.mkdirSync(path.dirname(session), { recursive: true });
      fs.writeFileSync(session, before);
    });

    it('a refused or cancelled authorization: exit 1, the file byte for byte as it was', async () => {
      const cancelled = {
        authorization: () => ({
          authorize: async () => {
            throw new Error('the user cancelled the login');
          },
        }),
        workDir,
      };
      await expect(
        runGenerateEnv(
          ['TRIAL', abapKey(), session, '--grant', 'authorization_code'],
          cancelled,
        ),
      ).resolves.toBe(1);
      expect(fs.readFileSync(session, 'utf8')).toBe(before);
    });

    it('a token endpoint that refuses: exit 1, the file unchanged', async () => {
      server.answer('/oauth/token', {
        status: 401,
        body: { error: 'invalid_client' },
      });
      await expect(
        runGenerateEnv(
          ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
          noBrowser,
        ),
      ).resolves.toBe(1);
      expect(fs.readFileSync(session, 'utf8')).toBe(before);
    });

    it('a secret the store does not take: exit 1, the file unchanged', async () => {
      server.answer('/oauth/token', tokenAnswer('cc', false));
      const spy = jest
        .spyOn(AbapSessionStore.prototype, 'saveSession')
        .mockRejectedValue(new Error('disk full'));
      try {
        await expect(
          runGenerateEnv(
            ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
            noBrowser,
          ),
        ).resolves.toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect(fs.readFileSync(session, 'utf8')).toBe(before);
    });

    it('success replaces the means and writes the secret', async () => {
      server.answer('/oauth/token', tokenAnswer('cc', false));
      await expect(
        runGenerateEnv(
          ['TRIAL', abapKey(), session, '--grant', 'client_credentials'],
          noBrowser,
        ),
      ).resolves.toBe(0);
      const after = fs.readFileSync(session, 'utf8');
      expect(after).toContain('SAP_GRANT_TYPE=client_credentials');
      expect(after).not.toContain('old-password');
    });
  });
});
