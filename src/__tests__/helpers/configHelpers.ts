/**
 * Configuration helpers for auth-broker tests
 * Loads test configuration from test-config.yaml
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

let cachedConfig: any = null;

export interface TestConfig {
  auth_broker?: {
    paths?: {
      service_keys_dir?: string;
      sessions_dir?: string;
    };
    abap?: {
      destination?: string;
      expired_token?: string; // Real expired token from previous session (optional)
      refresh_token?: string; // Real refresh token for testing (optional)
    };
    xsuaa?: {
      btp_destination?: string;
      mcp_destination?: string;
      mcp_url?: string; // MCP server URL (not BTP URL - BTP is for full-scope ABAP access)
    };
  };
}

/**
 * Find project root directory by looking for package.json
 */
function findProjectRoot(): string {
  let currentDir = __dirname;
  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  // Fallback to process.cwd() if package.json not found
  return process.cwd();
}

/**
 * Load test configuration from YAML
 * Uses test-config.yaml from tests/ directory
 */
export function loadTestConfig(): TestConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  // Find project root and load from tests/test-config.yaml
  const projectRoot = findProjectRoot();
  const configPath = path.resolve(projectRoot, 'tests', 'test-config.yaml');
  const templatePath = path.resolve(
    projectRoot,
    'tests',
    'test-config.yaml.template',
  );

  if (process.env.TEST_VERBOSE) {
    console.log(`[configHelpers] Project root: ${projectRoot}`);
    console.log(`[configHelpers] Config path: ${configPath}`);
    console.log(`[configHelpers] Config exists: ${fs.existsSync(configPath)}`);
  }

  if (fs.existsSync(configPath)) {
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      cachedConfig = (yaml.load(configContent) as TestConfig) || {};
      if (process.env.TEST_VERBOSE) {
        console.log(
          `[configHelpers] Loaded config:`,
          JSON.stringify(cachedConfig, null, 2),
        );
      }
      return cachedConfig;
    } catch (error) {
      console.warn(`Failed to load test config from ${configPath}:`, error);
      return {};
    }
  }

  if (fs.existsSync(templatePath)) {
    console.warn(
      '⚠️  tests/test-config.yaml not found. Using template (all integration tests will be disabled).',
    );
    try {
      const templateContent = fs.readFileSync(templatePath, 'utf8');
      cachedConfig = (yaml.load(templateContent) as TestConfig) || {};
      return cachedConfig;
    } catch (error) {
      console.warn(
        `Failed to load test config template from ${templatePath}:`,
        error,
      );
      return {};
    }
  }

  console.warn('⚠️  Test configuration files not found.');
  console.warn('Please create tests/test-config.yaml with test parameters.');
  return {};
}

/**
 * Check if test config has real values (not placeholders)
 */
export function hasRealConfig(
  config: TestConfig,
  section: 'abap' | 'xsuaa',
): boolean {
  if (!config.auth_broker) {
    return false;
  }

  if (section === 'abap') {
    const abap = config.auth_broker.abap;
    if (!abap?.destination) {
      return false;
    }
    // Check if destination is not a placeholder
    return !abap.destination.includes('<') && !abap.destination.includes('>');
  }

  if (section === 'xsuaa') {
    const xsuaa = config.auth_broker.xsuaa;
    if (!xsuaa?.btp_destination || !xsuaa?.mcp_url) {
      return false;
    }
    // Check if values are not placeholders
    return !xsuaa.btp_destination.includes('<') && !xsuaa.mcp_url.includes('<');
  }

  return false;
}

/**
 * Get ABAP destination from config
 */
export function getAbapDestination(config?: TestConfig): string | null {
  const cfg = config || loadTestConfig();
  return cfg.auth_broker?.abap?.destination || null;
}

/**
 * Get XSUAA destinations from config
 */
export function getXsuaaDestinations(config?: TestConfig): {
  btp_destination: string | null;
  mcp_url: string | null;
} {
  const cfg = config || loadTestConfig();
  const xsuaa = cfg.auth_broker?.xsuaa;
  return {
    btp_destination: xsuaa?.btp_destination || null,
    mcp_url: xsuaa?.mcp_url || null,
  };
}

/**
 * Expand tilde (~) to home directory
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith('~')) {
    const os = require('node:os');
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Get service keys directory from config
 */
export function getServiceKeysDir(config?: TestConfig): string | null {
  const cfg = config || loadTestConfig();
  const dir = cfg.auth_broker?.paths?.service_keys_dir;
  if (!dir) {
    return null;
  }
  // Expand ~ and normalize path
  const expanded = expandTilde(dir);
  return path.resolve(expanded);
}

/**
 * Get sessions directory from config
 */
export function getSessionsDir(config?: TestConfig): string | null {
  const cfg = config || loadTestConfig();
  const dir = cfg.auth_broker?.paths?.sessions_dir;
  if (!dir) {
    return null;
  }
  // Expand ~ and normalize path
  const expanded = expandTilde(dir);
  return path.resolve(expanded);
}

/**
 * Get expired token from config (real expired token from YAML)
 */
export function getExpiredToken(config?: TestConfig): string | null {
  const cfg = config || loadTestConfig();
  return cfg.auth_broker?.abap?.expired_token || null;
}

/**
 * Get refresh token from config (real refresh token from YAML)
 */
export function getRefreshToken(config?: TestConfig): string | null {
  const cfg = config || loadTestConfig();
  return cfg.auth_broker?.abap?.refresh_token || null;
}
