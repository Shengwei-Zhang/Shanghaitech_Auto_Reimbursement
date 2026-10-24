import fs from 'node:fs';
import path from 'node:path';

/** The version of this copy, from package.json (set by scripts/release.mjs, see CHANGELOG.md); '' when unreadable. */
export function appVersion(root = path.resolve(__dirname, '../..')): string {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : '';
  } catch { return ''; }
}

export const APP_VERSION = appVersion();
