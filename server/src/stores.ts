import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NearbyStore, StoreBrand } from '../../shared/types';
import { config } from './config';
import { haversine, resample } from './geo';

// 便利商店資料：啟動時從快取檔載入；沒有或過期時在背景向 Overpass 下載全台資料（約 1.3 萬筆）。
// 不在每次規劃時查 Overpass（公開伺服器常忙碌、有流量限制）。

interface Store {
  name: string;
  brand: StoreBrand;
  lat: number;
  lng: number;
  openingHours?: string;
}

type Status = 'loading' | 'ready' | 'error';

let stores: Store[] = [];
let status: Status = 'loading';
let lastError: string | null = null;
let updatedAt: string | null = null;
const CELL = 0.002; // 約 200 m
const grid = new Map<string, Store[]>();

const cellKey = (lat: number, lng: number) => `${Math.floor(lat / CELL)},${Math.floor(lng / CELL)}`;

function detectBrand(text: string): StoreBrand {
  if (/7-?eleven|統一超商/i.test(text)) return 'seven';
  if (/全家|family\s*mart/i.test(text)) return 'family';
  if (/萊爾富|hi-?life/i.test(text)) return 'hilife';
  if (/^ok|ok超商|ok便利/i.test(text)) return 'ok';
  return 'other';
}

interface OverpassElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function parseOverpass(json: { elements: OverpassElement[] }): Store[] {
  const out: Store[] = [];
  for (const e of json.elements) {
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    const t = e.tags ?? {};
    if (lat === undefined || lng === undefined) continue;
    const brandText = `${t.brand ?? ''} ${t.name ?? ''}`;
    // 蝦皮店到店是包裹取貨點，沒有賣水
    if (/蝦皮|店到店/.test(brandText)) continue;
    const base = t.brand ?? t.name ?? '便利商店';
    const name = t.branch ? `${base} ${t.branch}` : t.name ?? base;
    out.push({ name, brand: detectBrand(brandText), lat, lng, openingHours: t.opening_hours });
  }
  return out;
}

function setStores(list: Store[], when: string) {
  stores = list;
  grid.clear();
  for (const s of list) {
    const k = cellKey(s.lat, s.lng);
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(s);
  }
  status = 'ready';
  updatedAt = when;
}

async function download(): Promise<{ elements: OverpassElement[] }> {
  const b = config.storesBbox;
  const query =
    `[out:json][timeout:180];nwr["shop"="convenience"](${b.minLat},${b.minLng},${b.maxLat},${b.maxLng});out center tags;`;
  let lastErr: unknown = null;
  for (const url of config.overpassUrls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': config.userAgent },
        signal: AbortSignal.timeout(240_000),
      });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith('{')) {
        throw new Error(`${url} HTTP ${res.status}${/too busy/.test(text) ? '（伺服器忙碌）' : ''}`);
      }
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** 載入便利商店資料；不會丟出例外，失敗時記錄狀態 */
export async function initStores(log: (msg: string) => void): Promise<void> {
  const file = config.storesFile;
  let cached: { updatedAt: string; elements: OverpassElement[] } | null = null;
  try {
    cached = JSON.parse(await readFile(file, 'utf8'));
    const ageDays = (Date.now() - (await stat(file)).mtimeMs) / 86_400_000;
    loadStoresFromOverpass(cached!, cached!.updatedAt);
    log(`便利商店：已載入 ${stores.length} 筆（${cached!.updatedAt}）`);
    if (ageDays < config.storesMaxAgeDays) return;
    log('便利商店資料超過有效期，背景更新中…');
  } catch {
    log('便利商店：沒有快取資料，從 Overpass 下載全台資料中（約 1 分鐘）…');
  }
  try {
    const json = await download();
    const now = new Date().toISOString();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ updatedAt: now, elements: json.elements }));
    loadStoresFromOverpass(json, now);
    log(`便利商店：下載完成 ${stores.length} 筆`);
  } catch (err) {
    lastError = (err as Error).message;
    if (!cached) status = 'error';
    log(`便利商店：下載失敗（${lastError}）${cached ? '，繼續使用舊資料' : '，可稍後重啟 server 再試'}`);
  }
}

export function storesStatus() {
  return { status, count: stores.length, updatedAt, error: lastError };
}

/** 以 Overpass JSON 載入（也供測試使用） */
export function loadStoresFromOverpass(json: { elements: OverpassElement[] }, when = new Date().toISOString()) {
  setStores(parseOverpass(json), when);
}

/** 找出路線 radius 公尺內的便利商店（radius 需 ≤ 200，對應網格大小），依沿路距離排序（環狀路線經過兩次時取第一次） */
export function storesAlongRoute(coords: [number, number, number][], radius = 100): NearbyStore[] {
  if (status !== 'ready' || coords.length < 2) return [];
  const samples = resample(coords, 20);
  // firstM：第一次進入範圍的位置；只在第一次經過（300 m 內）取最近點，之後的經過忽略
  const found = new Map<Store, { firstM: number; alongM: number; offsetM: number }>();
  for (const p of samples) {
    const cy = Math.floor(p.lat / CELL);
    const cx = Math.floor(p.lng / CELL);
    for (let i = cy - 1; i <= cy + 1; i++) {
      for (let j = cx - 1; j <= cx + 1; j++) {
        const arr = grid.get(`${i},${j}`);
        if (!arr) continue;
        for (const s of arr) {
          const d = haversine(p.lat, p.lng, s.lat, s.lng);
          if (d > radius) continue;
          const prev = found.get(s);
          if (!prev) found.set(s, { firstM: p.d, alongM: p.d, offsetM: d });
          else if (p.d - prev.firstM < 300 && d < prev.offsetM) {
            prev.alongM = p.d;
            prev.offsetM = d;
          }
        }
      }
    }
  }
  return [...found.entries()]
    .map(([s, f]) => ({
      name: s.name,
      brand: s.brand,
      lng: s.lng,
      lat: s.lat,
      alongM: Math.round(f.alongM),
      offsetM: Math.round(f.offsetM),
      openingHours: s.openingHours,
    }))
    .sort((a, b) => a.alongM - b.alongM);
}
