import type { ImportRequest, ImportResponse, LatLng, RoutePreferences } from '../../shared/types';
import { route, type CallCounter, type RawRoute } from './brouter';
import { config } from './config';
import { mergeRoutes } from './generator';
import { haversine, polylineLength, resample } from './geo';
import { createLimiter } from './limiter';
import { overlapRatio, routeMetrics } from './metrics';
import { storesAlongRoute } from './stores';

// 匯入 GPX：把軌跡「貼」到道路上（每隔約 100 m 取一個途經點讓 BRouter 依序經過），
// 才能算出紅綠燈、路型、便利商店，並與規劃出的路線用同一套方式比較。

/** 比對用的中性偏好：不避紅綠燈、不偏好任何路型，盡量貼著原軌跡 */
const NEUTRAL: RoutePreferences = { avoidSignals: false, sidewalk: 0, cycleway: 0, road: 0 };
const MAX_VIAS = 600;
const CHUNK = 40;

/**
 * GPS 紀錄常在道路兩側飄移，直接當途經點會讓 BRouter 繞到對面再折回。
 * 以沿軌跡前後 halfWindow 公尺內的點做平均，去除飄移（也讓原始距離不被鋸齒灌水）。
 */
export function smoothTrack(pts: [number, number][], halfWindow = 15): [number, number][] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + haversine(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]));
  }
  const out: [number, number][] = [];
  let lo = 0;
  let hi = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < pts.length; i++) {
    while (hi < pts.length && cum[hi] - cum[i] <= halfWindow) {
      sx += pts[hi][0];
      sy += pts[hi][1];
      hi++;
    }
    while (cum[i] - cum[lo] > halfWindow) {
      sx -= pts[lo][0];
      sy -= pts[lo][1];
      lo++;
    }
    const n = hi - lo;
    out.push([sx / n, sy / n]);
  }
  // 保留真正的起終點
  out[0] = pts[0];
  out[out.length - 1] = pts[pts.length - 1];
  return out;
}

/** GPS 紀錄前處理：每 5 m 等距取樣 → 平滑 → 每 20 m 取一點（實測 ±8 m 白雜訊下距離誤差 < 1%） */
export function cleanTrack(pts: [number, number][], halfWindow = 15): [number, number][] {
  if (halfWindow <= 0) return pts;
  // 先依距離等間隔取樣：點位疏密不均時，直接平均會把彎道往內拉
  const even = resample(
    pts.map((p) => [p[0], p[1], 0] as [number, number, number]),
    5,
  ).map((p) => [p.lng, p.lat] as [number, number]);
  const s = smoothTrack(even, halfWindow);
  const out: [number, number][] = [s[0]];
  for (const p of s) {
    const q = out[out.length - 1];
    if (haversine(q[1], q[0], p[1], p[0]) >= 20) out.push(p);
  }
  const last = s[s.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * 找出比對結果中的「U 字折返」：路線沿同一串座標出去又原路回來。
 * 回傳每個折返的頂點座標與長度（出去 + 回來）。
 */
export function findSpurs(
  coords: [number, number, number][],
): { apex: LatLng; mid: LatLng; lengthM: number }[] {
  const same = (i: number, j: number) =>
    Math.abs(coords[i][0] - coords[j][0]) < 1e-6 && Math.abs(coords[i][1] - coords[j][1]) < 1e-6;
  const spurs: { apex: LatLng; mid: LatLng; lengthM: number }[] = [];
  for (let k = 1; k < coords.length - 1; k++) {
    if (!same(k - 1, k + 1)) continue;
    let m = 1;
    while (k - m - 1 >= 0 && k + m + 1 < coords.length && same(k - m - 1, k + m + 1)) m++;
    let len = 0;
    for (let i = k - m + 1; i <= k; i++) {
      len += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    const midIdx = k - Math.ceil(m / 2);
    spurs.push({
      apex: { lng: coords[k][0], lat: coords[k][1] },
      mid: { lng: coords[midIdx][0], lat: coords[midIdx][1] },
      lengthM: 2 * len,
    });
    k += m;
  }
  return spurs;
}

async function matchVias(vias: LatLng[], counter: CallCounter): Promise<RawRoute> {
  const chunks: LatLng[][] = [];
  for (let i = 0; i < vias.length - 1; i += CHUNK - 1) chunks.push(vias.slice(i, i + CHUNK));
  const limit = createLimiter(config.routerConcurrency);
  const parts = await Promise.all(chunks.map((c) => limit(() => route(c, NEUTRAL, counter))));
  return parts.reduce((a, b) => mergeRoutes(a, b));
}

export async function importTrack(
  req: ImportRequest,
  opts: { halfWindow?: number; spacing?: number } = {},
): Promise<ImportResponse> {
  const isTrack = req.source === 'track';
  const pts = isTrack ? cleanTrack(req.points, opts.halfWindow) : req.points;
  const trackLen = polylineLength(pts);

  const spacing = Math.max(opts.spacing ?? 100, trackLen / MAX_VIAS);
  const counter: CallCounter = { calls: 0 };

  /** 每隔 spacing 公尺取一個途經點（起終點一定保留） */
  const pickVias = (): LatLng[] => {
    const vias: LatLng[] = [{ lng: pts[0][0], lat: pts[0][1] }];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      acc += haversine(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
      if (acc >= spacing) {
        vias.push({ lng: pts[i][0], lat: pts[i][1] });
        acc = 0;
      }
    }
    // 終點：若最後一個途經點離終點太近，直接以終點取代，避免在終點前折返
    const last = { lng: pts[pts.length - 1][0], lat: pts[pts.length - 1][1] };
    const prev = vias[vias.length - 1];
    if (vias.length > 1 && haversine(prev.lat, prev.lng, last.lat, last.lng) < spacing / 2) vias.pop();
    vias.push(last);
    return vias;
  };

  // 軌跡的累積距離，用來判斷原始軌跡本身是否「經過同一處兩次」
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]));
  /** 原始軌跡是否在 p 附近往返（兩次經過相隔 gap 公尺以上） */
  const trackPassesTwice = (p: LatLng, gap: number) => {
    const hits = pts.map((q, i) => (haversine(p.lat, p.lng, q[1], q[0]) <= 25 ? cum[i] : -1)).filter((d) => d >= 0);
    return hits.length > 0 && hits[hits.length - 1] - hits[0] >= gap;
  };

  const matchOnce = async (): Promise<RawRoute> => {
    let vias = pickVias();
    let raw = await matchVias(vias, counter);
    // 途經點被吸到路口延伸段、死巷或平行道路時會出現假的 U 字折返：
    // 去掉造成折返的途經點再比對（最多兩輪）。原始軌跡本身在該處往返（跑到底再回頭）則保留。
    for (let round = 0; round < 2; round++) {
      const bogus = findSpurs(raw.coordinates).filter(
        (sp) => sp.lengthM < 60 || !trackPassesTwice(sp.mid, sp.lengthM * 0.5),
      );
      const drop = new Set<number>();
      for (const sp of bogus) {
        vias.forEach((v, i) => {
          if (i > 0 && i < vias.length - 1 && haversine(v.lat, v.lng, sp.apex.lat, sp.apex.lng) <= 60) drop.add(i);
        });
      }
      if (!drop.size) break;
      vias = vias.filter((_, i) => !drop.has(i));
      raw = await matchVias(vias, counter);
    }
    return raw;
  };

  const raw = isTrack ? await matchOnce() : await matchVias(pickVias(), counter);

  const warnings: string[] = [];
  if (!isTrack) {
    warnings.push('此 GPX 只有路線點（rtept），已依道路連接各點；實際路徑可能與原規劃軟體不同');
  } else {
    // 雙向檢查：軌跡有多少不在道路上、比對結果有多少是軌跡沒跑過的
    const trackOnRoad = overlapRatio(pts, raw.coordinates, 40);
    const routeOnTrack = overlapRatio(raw.coordinates, pts, 40);
    if (trackOnRoad < 0.9) {
      warnings.push(
        `約 ${Math.round((1 - trackOnRoad) * 100)}% 的軌跡對不上道路資料（例如山徑、操場或 GPS 訊號不良），該部分以最近的道路代替`,
      );
    }
    if (routeOnTrack < 0.9) {
      warnings.push(`貼齊道路後約有 ${Math.round((1 - routeOnTrack) * 100)}% 的路段不在原軌跡上，數據僅供參考`);
    }
  }

  return {
    route: {
      id: `gpx-${Date.now().toString(36)}`,
      coordinates: raw.coordinates,
      ...routeMetrics(raw),
      stores: storesAlongRoute(raw.coordinates),
      kind: 'imported',
      name: req.name,
    },
    warnings,
  };
}
