/**
 * Abstract Session Store - base class for session stores
 * 
 * Provides common functionality for file-based session stores.
 * Subclasses implement format-specific read/write logic.
 */

import { ISessionStore } from './interfaces';
import { EnvConfig, BtpSessionConfig } from '../types';
import { findFileInPaths } from '../pathResolver';
import { resolveSearchPaths } from '../pathResolver';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Abstract base class for session stores
 * 
 * Handles common file operations. Subclasses provide format-specific logic.
 */
export abstract class AbstractSessionStore implements ISessionStore {
  protected searchPaths: string[];

  /**
   * Create a new AbstractSessionStore instance
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
  protected abstract loadFromFile(filePath: string): Promise<EnvConfig | BtpSessionConfig | null>;

  /**
   * Save session to file
   * Must be implemented by subclasses
   * @param filePath Path to session file
   * @param config Session configuration to save
   */
  protected abstract saveToFile(filePath: string, config: EnvConfig | BtpSessionConfig): Promise<void>;

  /**
   * Load session configuration for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @returns Session config object or null if not found
   */
  async loadSession(destination: string): Promise<EnvConfig | BtpSessionConfig | null> {
    const fileName = this.getFileName(destination);
    const sessionPath = findFileInPaths(fileName, this.searchPaths);

    if (!sessionPath) {
      return null;
    }

    try {
      return await this.loadFromFile(sessionPath);
    } catch (error) {
      throw new Error(
        `Failed to load session for destination "${destination}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Save session configuration for destination
   * @param destination Destination name (e.g., "TRIAL" or "mcp")
   * @param config Session configuration to save
   */
  async saveSession(destination: string, config: EnvConfig | BtpSessionConfig): Promise<void> {
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

