import fs from 'node:fs';
import { parseSiteProfile, type SiteProfile } from '../domain/workflow';

export function loadSiteProfile(filename?: string): SiteProfile | undefined {
  if (!filename?.trim()) return undefined;
  return parseSiteProfile(JSON.parse(fs.readFileSync(filename, 'utf8')));
}
