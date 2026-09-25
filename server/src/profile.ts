import { readFileSync } from 'node:fs';
import type { RoutePreferences } from '../../shared/types';
import { config } from './config';

let template: string | null = null;

function loadTemplate(): string {
  if (template === null) template = readFileSync(config.profileTemplate, 'utf8');
  return template;
}

/** 使用者偏好 + server 內部決定的選項 */
export interface ProfileOptions extends RoutePreferences {
  avoidClimb?: boolean;
}

/** 以偏好設定替換樣板中 global 區塊的參數值 */
export function buildProfile(prefs: ProfileOptions): string {
  const values: Record<string, number> = {
    avoid_signals: prefs.avoidSignals ? 1 : 0,
    avoid_climb: prefs.avoidClimb ? 1 : 0,
    pref_sidewalk: prefs.sidewalk,
    pref_cycleway: prefs.cycleway,
    pref_road: prefs.road,
  };
  let text = loadTemplate();
  for (const [name, value] of Object.entries(values)) {
    const re = new RegExp(`^(assign\\s+${name}\\s*=\\s*)(-?[\\d.]+)`, 'm');
    if (!re.test(text)) throw new Error(`profile 樣板缺少參數 ${name}`);
    text = text.replace(re, `$1${value}`);
  }
  return text;
}

export function profileKey(prefs: ProfileOptions): string {
  return `${prefs.avoidSignals ? 1 : 0}|${prefs.sidewalk}|${prefs.cycleway}|${prefs.road}|${prefs.avoidClimb ? 1 : 0}`;
}
