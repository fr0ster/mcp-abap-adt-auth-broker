/**
 * Abstract JSON Session Store - base class for JSON-based session stores
 * 
 * Provides common functionality for file-based session stores that use JSON format.
 * Subclasses implement format-specific read/write logic.
 */

import { ISessionStore, IAuthorizationConfig, IConnectionConfig } from './interfaces';
import { IConfig } from '../types';
import { findFileInPaths, resolveSearchPaths } from '../utils/pathResolver';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Abstract base class for JSON-based session stores
 * 
 * Handles common file operations. Subclasses provide format-specific logic.
 */
export abstract class AbstractJsonSessionStore {
  protected searchPaths: string[];

  /**
   * Create a new AbstractJsonSessionStore instance
   * @param searchPaths Optional search paths for session files.
   *                    Can be a single path (string) or array of paths.
   *                    If not provided, uses AUTH_BROKER_PATH env var or current working directory.
   */
  constructor(searchPaths?: string | string[]) {
    this.searchPaths = resolveSearchPaths(searchPaths);
  }

  /**
   * Get file name for destination
   * Must be implemented by subclasses
   * @param destination Destination name
   * @returns File name (e.g., "TRIAL.env" or "mcp.env")
   */
  protected abstract getFileName(destination: string): string;

  /**
   * Load session from file
   * Must be implemented by subclasses
   * @param filePath Path to session file
   * @returns Parsed session config or null if invalid
   */
  protected abstract loadFromFile(filePath: string): Promise<unknown | null>;

  /**
   * Save session to file
   * Must be implemented by subclasses
   * @param filePath Path to session file
   * @param config Session configuration to save
   */
  protected abstract saveToFile(filePath: string, config: unknown): Promise<void>;

  /**
   * Load session configuration for destination
   * Returns optional composition of IAuthorizationConfig and IConnectionConfig
   * Must be implemented by subclasses
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns IConfig with actual values or null if not found
   */
  abstract loadSession(destination: string): Promise<IConfig | null>;

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config Session configuration to save
   */
  async saveSession(destination: string, config: unknown): Promise<void> {
    const fileName = this.getFileName(destination);
    
    // Use first search path for saving
    const savePath = this.searchPaths.length > 0 
      ? path.join(this.searchPaths[0], fileName)
      : path.join(process.cwd(), fileName);

    // Ensure directory exists
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await this.saveToFile(savePath, config);
  }

  /**
   * Delete session for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   */
  async deleteSession(destination: string): Promise<void> {
    const fileName = this.getFileName(destination);
    const sessionPath = findFileInPaths(fileName, this.searchPaths);

    if (sessionPath && fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
  }

  /**
   * Get search paths (for error messages)
   * @returns Array of search paths
   */
  getSearchPaths(): string[] {
    return [...this.searchPaths];
  }

}

