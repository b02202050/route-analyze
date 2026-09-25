import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  brouterUrl: (process.env.BROUTER_URL ?? 'http://localhost:17777').replace(/\/$/, ''),
  profileTemplate:
    process.env.PROFILE_TEMPLATE ?? path.join(repoRoot, 'brouter', 'profiles', 'running.brf'),
  webDist: process.env.WEB_DIST ?? path.join(repoRoot, 'web', 'dist'),
  /** 路網資料（E120_N20 + E120_N25）涵蓋全台灣 */
  serviceBounds: { minLat: 21.8, maxLat: 26.5, minLng: 118.0, maxLng: 122.3 },
  /** 地點搜尋優先範圍：桃園市 */
  geocodeViewbox: { minLng: 120.98, minLat: 24.58, maxLng: 121.5, maxLat: 25.13 },
  nominatimUrl: process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org',
  userAgent: process.env.USER_AGENT ?? 'route-analyze/0.1 (personal running route planner)',
  /** 便利商店資料（Overpass 下載後快取於此） */
  storesFile: process.env.STORES_FILE ?? path.join(repoRoot, 'server', 'data', 'convenience-stores.json'),
  storesMaxAgeDays: Number(process.env.STORES_MAX_AGE_DAYS ?? 30),
  overpassUrls: (
    process.env.OVERPASS_URLS ??
    'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter'
  ).split(','),
  /** 台灣本島 + 澎湖（下載便利商店用） */
  storesBbox: { minLat: 21.8, minLng: 119.3, maxLat: 25.4, maxLng: 122.1 },
  /** 同時送往 BRouter 的請求數 */
  routerConcurrency: Number(process.env.ROUTER_CONCURRENCY ?? 4),
};
