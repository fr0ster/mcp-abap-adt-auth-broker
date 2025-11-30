/**
 * Tests for pathResolver module
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { resolveSearchPaths, findFileInPaths } from '../pathResolver';

describe('pathResolver', () => {
  const originalEnv = process.env.AUTH_BROKER_PATH;
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.AUTH_BROKER_PATH;
  });

  afterEach(() => {
    process.env.AUTH_BROKER_PATH = originalEnv;
    process.chdir(originalCwd);
  });

  describe('resolveSearchPaths', () => {
    it('should use constructor parameter as highest priority', () => {
      const paths = resolveSearchPaths(['/custom/path1', '/custom/path2']);
      expect(paths).toContain(path.resolve('/custom/path1'));
      expect(paths).toContain(path.resolve('/custom/path2'));
    });

    it('should handle single string path in constructor', () => {
      const paths = resolveSearchPaths('/single/path');
      expect(paths).toContain(path.resolve('/single/path'));
    });

    it('should use AUTH_BROKER_PATH environment variable', () => {
      process.env.AUTH_BROKER_PATH = '/env/path1:/env/path2';
      const paths = resolveSearchPaths();
      expect(paths).toContain(path.resolve('/env/path1'));
      expect(paths).toContain(path.resolve('/env/path2'));
    });

    it('should handle Windows-style semicolon separator in AUTH_BROKER_PATH', () => {
      process.env.AUTH_BROKER_PATH = '/path1;/path2';
      const paths = resolveSearchPaths();
      expect(paths.length).toBeGreaterThanOrEqual(2);
    });

    it('should use current working directory when no paths specified', () => {
      const paths = resolveSearchPaths();
      expect(paths).toContain(process.cwd());
    });

    it('should prioritize constructor over environment variable', () => {
      process.env.AUTH_BROKER_PATH = '/env/path';
      const paths = resolveSearchPaths(['/constructor/path']);
      expect(paths[0]).toBe(path.resolve('/constructor/path'));
      expect(paths).toContain(path.resolve('/env/path'));
    });

    it('should remove duplicate paths', () => {
      const paths = resolveSearchPaths(['/same/path', '/same/path']);
      const uniquePaths = [...new Set(paths)];
      expect(paths.length).toBe(uniquePaths.length);
    });

    it('should normalize paths', () => {
      const paths = resolveSearchPaths(['/path/../normalized']);
      expect(paths[0]).toBe(path.resolve('/normalized'));
    });
  });

  describe('findFileInPaths', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-test-'));
    });

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should find file in first path', () => {
      const dir1 = path.join(tempDir, 'dir1');
      const dir2 = path.join(tempDir, 'dir2');
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });

      const testFile = path.join(dir1, 'test.txt');
      fs.writeFileSync(testFile, 'content');

      const found = findFileInPaths('test.txt', [dir1, dir2]);
      expect(found).toBe(testFile);
    });

    it('should find file in second path if not in first', () => {
      const dir1 = path.join(tempDir, 'dir1');
      const dir2 = path.join(tempDir, 'dir2');
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });

      const testFile = path.join(dir2, 'test.txt');
      fs.writeFileSync(testFile, 'content');

      const found = findFileInPaths('test.txt', [dir1, dir2]);
      expect(found).toBe(testFile);
    });

    it('should return null if file not found in any path', () => {
      const dir1 = path.join(tempDir, 'dir1');
      const dir2 = path.join(tempDir, 'dir2');
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });

      const found = findFileInPaths('nonexistent.txt', [dir1, dir2]);
      expect(found).toBeNull();
    });

    it('should return null for empty paths array', () => {
      const found = findFileInPaths('test.txt', []);
      expect(found).toBeNull();
    });
  });
});

