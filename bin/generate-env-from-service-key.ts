#!/usr/bin/env tsx

/**
 * Generate .env file from service key
 *
 * Usage:
 *   npm run generate-env <destination> [service-key-path] [session-path]
 *   or
 *   npx tsx bin/generate-env-from-service-key.ts <destination> [service-key-path] [session-path]
 *
 * Examples:
 *   npm run generate-env mcp
 *   npm run generate-env mcp ./mcp.json ./mcp.env
 *   npm run generate-env TRIAL ~/.config/mcp-abap-adt/service-keys/TRIAL.json
 */

import {
  AuthorizationCodeProvider,
  browserCallbackStrategy,
  ClientCredentialsProvider,
} from '@mcp-abap-adt/auth-providers';
import {
  AbapServiceKeyStore,
  AbapSessionStore,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';
import * as fs from 'fs';
import * as path from 'path';
import { AuthBroker } from '../src/AuthBroker';
import { refreshableProvider } from './refreshableProvider';

/**
 * A person completes this login at a browser; the provider's own default
 * (30s) is sized for an unattended caller instead.
 */
const INTERACTIVE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      'Usage: generate-env-from-service-key <destination> [service-key-path] [session-path]',
    );
    console.error('');
    console.error('Examples:');
    console.error('  generate-env-from-service-key mcp');
    console.error('  generate-env-from-service-key mcp ./mcp.json ./mcp.env');
    console.error(
      '  generate-env-from-service-key TRIAL ~/.config/mcp-abap-adt/service-keys/TRIAL.json',
    );
    process.exit(1);
  }

  const destination = args[0];
  const serviceKeyPath =
    args[1] || path.join(process.cwd(), `${destination}.json`);
  const sessionPath = args[2] || path.join(process.cwd(), `${destination}.env`);

  // Resolve paths
  const resolvedServiceKeyPath = path.resolve(serviceKeyPath);
  const resolvedSessionPath = path.resolve(sessionPath);
  const serviceKeyDir = path.dirname(resolvedServiceKeyPath);
  const sessionDir = path.dirname(resolvedSessionPath);

  // Check if service key file exists
  if (!fs.existsSync(resolvedServiceKeyPath)) {
    console.error(`❌ Service key file not found: ${resolvedServiceKeyPath}`);
    process.exit(1);
  }

  console.log(`📁 Service key: ${resolvedServiceKeyPath}`);
  console.log(`📁 Session file: ${resolvedSessionPath}`);

  try {
    // Load service key to determine type
    const rawServiceKey = JSON.parse(
      fs.readFileSync(resolvedServiceKeyPath, 'utf8'),
    );
    const isXsuaa =
      rawServiceKey.url &&
      rawServiceKey.url.includes('authentication') &&
      !rawServiceKey.uaa;

    // Create appropriate stores
    const serviceKeyStore = isXsuaa
      ? new XsuaaServiceKeyStore(serviceKeyDir)
      : new AbapServiceKeyStore(serviceKeyDir);

    // An XSUAA session store needs a service URL, and an XSUAA service key may
    // not carry one — the same placeholder mcp-auth uses, for the store's own
    // bookkeeping only.
    let xsuaaServiceUrl = '<SERVICE_URL>';
    if (isXsuaa) {
      try {
        const connection =
          await serviceKeyStore.getConnectionConfig(destination);
        xsuaaServiceUrl = connection?.serviceUrl || xsuaaServiceUrl;
      } catch {
        // No serviceUrl in the key: the placeholder stands.
      }
    }
    const abapServiceUrl = isXsuaa
      ? undefined
      : (await serviceKeyStore.getConnectionConfig(destination))?.serviceUrl;
    const sessionStore = isXsuaa
      ? new XsuaaSessionStore(sessionDir, xsuaaServiceUrl)
      : new AbapSessionStore(sessionDir, undefined, abapServiceUrl);

    const authConfig =
      await serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      throw new Error(`Missing authorization config for ${destination}`);
    }

    // The session file this script writes is read on its own later, with no
    // service key beside it, and refreshing needs the UAA credentials; so the
    // script puts them there itself. The broker no longer copies the client
    // secret into a session store.
    const sessionAuth = await sessionStore.getAuthorizationConfig(destination);
    if (!sessionAuth) {
      await sessionStore.setAuthorizationConfig(destination, authConfig);
    }

    // The factory form: the broker seeds each provider with what the stores
    // hold — the UAA credentials, the stored refresh token and access token.
    // TODO(auth-providers 4.2.0): return the provider itself; its own
    // refreshTokens() replaces the refreshableProvider adapter.
    const broker = new AuthBroker({
      serviceKeyStore,
      sessionStore,
      provider: (_destination, auth, conn) => {
        if (!auth) {
          throw new Error(`Missing authorization config for ${destination}`);
        }
        return refreshableProvider((refresh) =>
          isXsuaa
            ? new ClientCredentialsProvider({
                uaaUrl: auth.uaaUrl,
                clientId: auth.uaaClientId,
                clientSecret: auth.uaaClientSecret,
              })
            : new AuthorizationCodeProvider({
                uaaUrl: auth.uaaUrl,
                clientId: auth.uaaClientId,
                clientSecret: auth.uaaClientSecret,
                accessToken: refresh ? undefined : conn.authorizationToken,
                refreshToken: refresh?.refreshToken ?? auth.refreshToken,
                // No port override: this script has no `--redirect-port`
                // flag, so the callback port is the strategy's own choice.
                authorization: browserCallbackStrategy({
                  browser: 'system',
                  timeoutMs: INTERACTIVE_LOGIN_TIMEOUT_MS,
                }),
              }),
        );
      },
    });

    console.log(`🔐 Getting token for destination "${destination}"...`);
    if (isXsuaa) {
      console.log(
        `   Using client_credentials grant type (no browser required)`,
      );
    } else {
      console.log(`   Using browser authentication (browser will open)`);
    }

    // Get token (will use client_credentials for XSUAA or browser auth for ABAP)
    const token = await broker.getToken(destination);

    console.log(`✅ Token obtained successfully`);

    // Check if session file was created
    if (fs.existsSync(resolvedSessionPath)) {
      console.log(`✅ Session file created: ${resolvedSessionPath}`);

      // Show service URL if available
      const connConfig = await broker.getConnectionConfig(destination);
      if (connConfig?.serviceUrl) {
        if (isXsuaa) {
          console.log(`📁 MCP URL: ${connConfig.serviceUrl}`);
        } else {
          console.log(`📁 SAP URL: ${connConfig.serviceUrl}`);
        }
      } else if (isXsuaa) {
        console.log(
          `💡 Note: MCP URL not set in session (optional for XSUAA).`,
        );
        console.log(
          `   Provide MCP URL via YAML config, parameter, or request header when making requests.`,
        );
      }
    } else {
      console.log(
        `⚠️  Session file was not created. Token is cached in memory.`,
      );
    }
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
