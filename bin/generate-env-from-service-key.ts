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

import * as path from 'path';
import * as fs from 'fs';
import { AuthBroker } from '../src/AuthBroker';
import { AbapServiceKeyStore, AbapSessionStore, XsuaaServiceKeyStore, XsuaaSessionStore } from '../src/stores';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: generate-env-from-service-key <destination> [service-key-path] [session-path]');
    console.error('');
    console.error('Examples:');
    console.error('  generate-env-from-service-key mcp');
    console.error('  generate-env-from-service-key mcp ./mcp.json ./mcp.env');
    console.error('  generate-env-from-service-key TRIAL ~/.config/mcp-abap-adt/service-keys/TRIAL.json');
    process.exit(1);
  }

  const destination = args[0];
  const serviceKeyPath = args[1] || path.join(process.cwd(), `${destination}.json`);
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
    const rawServiceKey = JSON.parse(fs.readFileSync(resolvedServiceKeyPath, 'utf8'));
    const isXsuaa = rawServiceKey.url && rawServiceKey.url.includes('authentication') && !rawServiceKey.uaa;

    // Create appropriate stores
    const serviceKeyStore = isXsuaa
      ? new XsuaaServiceKeyStore([serviceKeyDir])
      : new AbapServiceKeyStore([serviceKeyDir]);
    
    const sessionStore = isXsuaa
      ? new XsuaaSessionStore([sessionDir])
      : new AbapSessionStore([sessionDir]);

    // Create AuthBroker
    // For ABAP, use 'system' browser (will open browser for auth)
    // For XSUAA, browser doesn't matter (uses client_credentials)
    const broker = new AuthBroker({
      serviceKeyStore,
      sessionStore,
    }, isXsuaa ? 'none' : 'system');

    console.log(`🔐 Getting token for destination "${destination}"...`);
    if (isXsuaa) {
      console.log(`   Using client_credentials grant type (no browser required)`);
    } else {
      console.log(`   Using browser authentication (browser will open)`);
    }
    
    // Get token (will use client_credentials for XSUAA or browser auth for ABAP)
    const token = await broker.getToken(destination);
    
    console.log(`✅ Token obtained successfully`);

    // Check if session file was created
    if (fs.existsSync(resolvedSessionPath)) {
      console.log(`✅ Session file created: ${resolvedSessionPath}`);
      
      // Show MCP URL if available (optional for XSUAA)
      if (isXsuaa) {
        const mcpUrl = await broker.getSapUrl(destination);
        if (mcpUrl) {
          console.log(`📁 MCP URL: ${mcpUrl}`);
        } else {
          console.log(`💡 Note: MCP URL not set in session (optional for XSUAA).`);
          console.log(`   Provide MCP URL via YAML config, parameter, or request header when making requests.`);
        }
      } else {
        const sapUrl = await broker.getSapUrl(destination);
        if (sapUrl) {
          console.log(`📁 SAP URL: ${sapUrl}`);
        }
      }
    } else {
      console.log(`⚠️  Session file was not created. Token is cached in memory.`);
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

