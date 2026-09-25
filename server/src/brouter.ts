import type { LatLng, RoutePreferences } from '../../shared/types';
import { config } from './config';
import { buildProfile, profileKey, type ProfileOptions } from './profile';

/** BRouter messages 中我們用到的欄位 */
export interface RouteMessage {
  lng: number;
  lat: number;
  /** 此段距離（m），即上一個 message 點到此點 */
  distance: number;
  wayTags: string;
  nodeTags: string;
}

export interface RawRoute {
  coordinates: [number, number, number][];
  trackLength: number;
  messages: RouteMessage[];
}

export class RouterError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** 計數器，用於回報每次產生共呼叫幾次 routing */
export interface CallCounter {
  calls: number;
}

const profileCache = new Map<string, { id: string; at: number }>();
const PROFILE_TTL_MS = 30 * 60 * 1000;

async function uploadProfile(prefs: ProfileOptions): Promise<string> {
  const res = await fetch(`${config.brouterUrl}/brouter/profile`, {
    method: 'POST',
    body: buildProfile(prefs),
    headers: { 'Content-Type': 'text/plain' },
  });
  const text = await res.text();
  let json: { profileid?: string; error?: string };
  try {
    json = JSON.parse(text);
  } catch {
    // BRouter 發生例外時會在 200 回應的內容中再寫一次 "HTTP/1.1 500" 標頭
    const internal = /500 Internal Server Error/.test(text);
    throw new RouterError(
      internal
        ? 'BRouter 上傳 profile 時發生內部錯誤，請執行 docker compose logs brouter 查看 Java 例外訊息'
        : `上傳 profile 失敗：${text.slice(0, 200)}`,
      res.status,
    );
  }
  if (!json.profileid) throw new RouterError(`profile 錯誤：${json.error ?? text}`);
  return json.profileid;
}

export async function getProfileId(prefs: ProfileOptions, forceRefresh = false): Promise<string> {
  const key = profileKey(prefs);
  const cached = profileCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.id;
  const id = await uploadProfile(prefs);
  profileCache.set(key, { id, at: Date.now() });
  return id;
}

async function requestRoute(
  points: LatLng[],
  profileId: string,
  alternativeIdx: number,
): Promise<Response> {
  const lonlats = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url =
    `${config.brouterUrl}/brouter?lonlats=${encodeURIComponent(lonlats)}` +
    `&profile=${encodeURIComponent(profileId)}&alternativeidx=${alternativeIdx}&format=geojson`;
  return fetch(url, { signal: AbortSignal.timeout(30_000) });
}

export async function route(
  points: LatLng[],
  prefs: ProfileOptions,
  counter: CallCounter,
  alternativeIdx = 0,
): Promise<RawRoute> {
  let profileId = await getProfileId(prefs);
  counter.calls++;
  let res: Response;
  try {
    res = await requestRoute(points, profileId, alternativeIdx);
  } catch (err) {
    throw new RouterError(`無法連線到 BRouter（${config.brouterUrl}）：${(err as Error).message}`);
  }
  // BRouter 會定期清除 custom profile，遇到 500 且無內容時重新上傳一次
  if (!res.ok && res.status === 500) {
    const body = await res.text();
    if (body.trim() === '' || /profile/i.test(body)) {
      profileId = await getProfileId(prefs, true);
      counter.calls++;
      res = await requestRoute(points, profileId, alternativeIdx);
    } else {
      throw new RouterError(body.trim(), res.status);
    }
  }
  const text = await res.text();
  if (!res.ok) throw new RouterError(text.trim() || `BRouter HTTP ${res.status}`, res.status);
  return parseGeoJson(text);
}

export function parseGeoJson(text: string): RawRoute {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RouterError(text.trim().slice(0, 300));
  }
  const feature = json?.features?.[0];
  if (!feature) throw new RouterError('BRouter 沒有回傳路線');
  const coordinates = (feature.geometry.coordinates as number[][]).map(
    (c) => [c[0], c[1], c[2] ?? 0] as [number, number, number],
  );
  const rawMessages: string[][] = feature.properties.messages ?? [];
  const header = rawMessages[0] ?? [];
  const idx = (name: string) => header.indexOf(name);
  const [iLng, iLat, iDist, iWay, iNode] = [
    idx('Longitude'),
    idx('Latitude'),
    idx('Distance'),
    idx('WayTags'),
    idx('NodeTags'),
  ];
  const messages: RouteMessage[] = rawMessages.slice(1).map((r) => ({
    lng: Number(r[iLng]) / 1e6,
    lat: Number(r[iLat]) / 1e6,
    distance: Number(r[iDist]),
    wayTags: r[iWay] ?? '',
    nodeTags: r[iNode] ?? '',
  }));
  return {
    coordinates,
    trackLength: Number(feature.properties['track-length']),
    messages,
  };
}

/** 實際上傳 profile 並規劃一段桃園市區的短路線，回傳錯誤訊息（null 代表正常） */
export async function brouterCheck(): Promise<string | null> {
  const prefs: RoutePreferences = { avoidSignals: true, sidewalk: 0, cycleway: 0, road: 0 };
  try {
    await route(
      [
        { lat: 24.9892, lng: 121.3137 },
        { lat: 24.9975, lng: 121.2969 },
      ],
      prefs,
      { calls: 0 },
    );
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
