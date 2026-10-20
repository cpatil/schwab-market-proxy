import { mkdir, readFile, rm, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';

/**
 * Persists OAuth tokens to a single owner-only file. Values are never logged.
 */
export class TokenStore {
  constructor(file) {
    this.file = file;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      return typeof parsed?.refresh_token === 'string' ? parsed : null;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new Error(`Token file ${this.file} is unreadable: ${err.message}`);
    }
  }

  async save(tokens) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  async clear() {
    await rm(this.file, { force: true });
  }
}
