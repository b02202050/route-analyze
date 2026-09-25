import type { GeocodeResult } from '../../shared/types';
import { config } from './config';

// Nominatim 使用政策：每秒最多 1 次、需帶 User-Agent、不可用於自動完成。
// 因此只在使用者按下搜尋時呼叫，並做節流與快取。
const cache = new Map<string, GeocodeResult[]>();
let lastCall = 0;
let chain: Promise<unknown> = Promise.resolve();

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

export async function geocode(q: string): Promise<GeocodeResult[]> {
  const query = q.trim();
  if (!query) return [];
  const hit = cache.get(query);
  if (hit) return hit;

  const vb = config.geocodeViewbox;
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '8',
    countrycodes: 'tw',
    'accept-language': 'zh-TW',
    viewbox: `${vb.minLng},${vb.maxLat},${vb.maxLng},${vb.minLat}`,
    bounded: '0',
  });
  const res = await throttle(() =>
    fetch(`${config.nominatimUrl}/search?${params}`, {
      headers: { 'User-Agent': config.userAgent },
      signal: AbortSignal.timeout(10_000),
    }),
  );
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const json = (await res.json()) as { display_name: string; name?: string; lat: string; lon: string }[];
  const results = json.map((r) => ({
    name: r.name ? `${r.name}（${shorten(r.display_name)}）` : r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
  }));
  if (cache.size > 500) cache.clear();
  cache.set(query, results);
  return results;
}

/** display_name 由小到大排列，取行政區部分並反轉成台灣習慣的順序 */
function shorten(displayName: string): string {
  const parts = displayName.split(',').map((s) => s.trim()).filter((s) => !/^\d+$/.test(s) && s !== '臺灣');
  return parts.slice(1, 4).reverse().join('');
}
