/**
 * Configuration helpers for auth-broker tests
 * Loads test configuration from test-config.yaml
 */

import * as fs from 'fs';
import * as path from 'path';
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
    };
    xsuaa?: {
      btp_destination?: string;
      mcp_destination?: string;
      btp_url?: string;
    };
  };
}

/**
 * Load test configuration from YAML
 * Uses test-config.yaml from tests/ directory
 */
export function loadTestConfig(): TestConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  // Load from tests/test-config.yaml
  const configPath = path.resolve(process.cwd(), 'tests', 'test-config.yaml');
  const templatePath = path.resolve(process.cwd(), 'tests', 'test-config.yaml.template');

  if (fs.existsSync(configPath)) {
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      cachedConfig = yaml.load(configContent) as TestConfig || {};
      return cachedConfig;
    } catch (error) {
      console.warn(`Failed to load test config from ${configPath}:`, error);
      return {};
    }
  }

  if (fs.existsSync(templatePath)) {
    console.warn('⚠️  tests/test-config.yaml not found. Using template (all integration tests will be disabled).');
    try {
      const templateContent = fs.readFileSync(templatePath, 'utf8');
      cachedConfig = yaml.load(templateContent) as TestConfig || {};
      return cachedConfig;
    } catch (error) {
      console.warn(`Failed to load test config template from ${templatePath}:`, error);
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
export function hasRealConfig(config: TestConfig, section: 'abap' | 'xsuaa'): boolean {
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
    if (!xsuaa?.btp_destination || !xsuaa?.btp_url) {
      return false;
    }
    // Check if values are not placeholders
    return (
      !xsuaa.btp_destination.includes('<') &&
      !xsuaa.btp_url.includes('<')
    );
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
  btp_url: string | null;
} {
  const cfg = config || loadTestConfig();
  const xsuaa = cfg.auth_broker?.xsuaa;
  return {
    btp_destination: xsuaa?.btp_destination || null,
    btp_url: xsuaa?.btp_url || null,
  };
}

/**
 * Get service keys directory from config
 */
export function getServiceKeysDir(config?: TestConfig): string | null {
  const cfg = config || loadTestConfig();
  return cfg.auth_broker?.paths?.service_keys_dir || null;
}

/**
 * Get sessions directory from config
 */
export function getSessionsDir(config?: TestConfig): string | null {
  const cfg = config || loadTestConfig();
  return cfg.auth_broker?.paths?.sessions_dir || null;
}

