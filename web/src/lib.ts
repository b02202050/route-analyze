import type { LatLng, RouteResult } from '../../shared/types';

export const ROUTE_COLORS = ['#e8553d', '#2b7bd6', '#8b4fd8', '#159a6a', '#d18a00'];
export const ROUTE_NAMES = ['A', 'B', 'C', 'D', 'E'];

export const KIND_LABEL: Record<RouteResult['kind'], string> = {
  shortest: '最佳路徑',
  alternative: '替代路線',
  random: '隨機路線',
};

export const CATEGORY_LABEL = {
  sidewalk: '人行道／步道',
  cycleway: '腳踏車道',
  road: '一般馬路',
} as const;

export const CATEGORY_COLOR = {
  sidewalk: '#16a34a',
  cycleway: '#f59e0b',
  road: '#9aa0a6',
} as const;

export const SIGNAL_COLOR = '#d93025';

/** 地圖上可切換顯示的路線圖層 */
export interface LayerToggles {
  signals: boolean;
  sidewalk: boolean;
  cycleway: boolean;
}

export const fmtKm = (m: number) => (m / 1000).toFixed(2);

export function pointLabel(p: LatLng): string {
  return p.label ?? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

/** "6:00" → 360 秒；格式錯誤回傳 null */
export function parsePace(pace: string): number | null {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(pace.trim());
  if (!m) return null;
  const sec = Number(m[1]) * 60 + Number(m[2]);
  return sec > 0 ? sec : null;
}

export function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r;
  const dLng = (b[0] - a[0]) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 沿路線距離 d（m）處的座標 */
export function pointAtDistance(coords: [number, number, number][], d: number): [number, number] | null {
  if (coords.length === 0) return null;
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const a: [number, number] = [coords[i - 1][0], coords[i - 1][1]];
    const b: [number, number] = [coords[i][0], coords[i][1]];
    const seg = haversine(a, b);
    if (acc + seg >= d) {
      const t = seg ? (d - acc) / seg : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    acc += seg;
  }
  const last = coords[coords.length - 1];
  return [last[0], last[1]];
}

/** 降低點數，用於傳送已鎖定路線給 server */
export function thinCoords(coords: [number, number, number][], max = 1500): [number, number][] {
  const stride = Math.max(1, Math.ceil(coords.length / max));
  const out: [number, number][] = [];
  for (let i = 0; i < coords.length; i += stride) out.push([coords[i][0], coords[i][1]]);
  const last = coords[coords.length - 1];
  if (last) out.push([last[0], last[1]]);
  return out;
}

export function downloadGpx(route: RouteResult, name: string) {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const pts = route.coordinates
    .map(([lng, lat, ele]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"><ele>${ele.toFixed(1)}</ele></trkpt>`)
    .join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="route-analyze" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${esc(name)}</name>
    <type>running</type>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`route-analyze:${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: unknown) {
  try {
    localStorage.setItem(`route-analyze:${key}`, JSON.stringify(value));
  } catch {
    /* 忽略 */
  }
}
