/**
 * Path resolver - resolves search paths for .env and .json files
 */

import * as path from 'path';

/**
 * Resolve search paths based on priority:
 * 1. Constructor parameter (array of paths) - highest priority
 * 2. AUTH_BROKER_PATH environment variable (colon/semicolon-separated paths)
 * 3. Current working directory - lowest priority
 * 
 * @param constructorPaths Optional array of paths from constructor
 * @returns Array of resolved absolute paths to search
 */
export function resolveSearchPaths(constructorPaths?: string | string[]): string[] {
  const paths: string[] = [];

  // Priority 1: Constructor parameter
  if (constructorPaths) {
    if (Array.isArray(constructorPaths)) {
      paths.push(...constructorPaths.map(p => path.resolve(p)));
    } else {
      paths.push(path.resolve(constructorPaths));
    }
  }

  // Priority 2: AUTH_BROKER_PATH environment variable
  const envPath = process.env.AUTH_BROKER_PATH;
  if (envPath) {
    // Support both colon (Unix) and semicolon (Windows) separators
    const envPaths = envPath.split(/[:;]/).map(p => p.trim()).filter(p => p.length > 0);
    paths.push(...envPaths.map(p => path.resolve(p)));
  }

  // Priority 3: Current working directory (only if no other paths specified)
  if (paths.length === 0) {
    paths.push(process.cwd());
  }

  // Remove duplicates while preserving order
  const uniquePaths: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const normalized = path.normalize(p);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniquePaths.push(normalized);
    }
  }

  return uniquePaths;
}

/**
 * Find file in multiple search paths
 * @param fileName File name to search for
 * @param searchPaths Array of paths to search
 * @returns Full path to file if found, null otherwise
 */
export function findFileInPaths(fileName: string, searchPaths: string[]): string | null {
  for (const searchPath of searchPaths) {
    const filePath = path.join(searchPath, fileName);
    try {
      const fs = require('fs');
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    } catch {
      // Ignore errors, continue searching
    }
  }
  return null;
}

