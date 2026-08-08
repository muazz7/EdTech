import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal persistent cookie jar for the dev scripts.
 *
 * Needed because the web device fingerprint is derived from an httpOnly cookie
 * plus the UA (Section 6.3). A script that discards cookies presents a brand-new
 * fingerprint on every run and burns the 4-per-30-days device-switch budget in
 * four runs, after which login correctly returns DEVICE_LIMIT_REACHED.
 *
 * Persisting the jar makes repeated runs look like the same browser, which is
 * what a real client does.
 */

// fileURLToPath, not URL.pathname: the latter is percent-encoded, so a repo
// path containing a space resolves to a directory that does not exist.
const FILE = join(dirname(fileURLToPath(import.meta.url)), '.dev-cookies.json');

export function createJar(name = 'default') {
  let store = {};
  if (existsSync(FILE)) {
    try {
      store = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch {
      store = {};
    }
  }
  store[name] ??= {};
  const jar = store[name];

  return {
    /** Cookie header value, or undefined when the jar is empty. */
    header() {
      const pairs = Object.entries(jar);
      return pairs.length ? pairs.map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
    },

    /** Records Set-Cookie values from a response. */
    capture(res) {
      const raw = res.headers.getSetCookie?.() ?? [];
      for (const line of raw) {
        const [pair] = line.split(';');
        const eq = pair?.indexOf('=') ?? -1;
        if (eq <= 0) continue;
        const key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        // An empty value is a deletion (logout clears the refresh cookie).
        if (value === '') delete jar[key];
        else jar[key] = value;
      }
    },

    save() {
      writeFileSync(FILE, JSON.stringify(store, null, 2));
    },

    /** Forgets session cookies but keeps device_fp, so the next run is still
     *  recognised as the same device. */
    clearSession() {
      delete jar.refresh_token;
      delete jar.session_id;
    },
  };
}
