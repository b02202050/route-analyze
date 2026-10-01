import type { ImportRequest, ImportResponse, LatLng, RoutePreferences } from '../../shared/types';
import { route, type CallCounter, type RawRoute } from './brouter';
import { config } from './config';
import { mergeRoutes } from './generator';
import { haversine, polylineLength, resample } from './geo';
import { createLimiter } from './limiter';
import { DEM_ELEVATION, GPX_ELEVATION, overlapRatio, routeMetrics } from './metrics';
import { storesAlongRoute } from './stores';

// 匯入 GPX：把軌跡「貼」到道路上（每隔約 100 m 取一個途經點讓 BRouter 依序經過），
// 才能算出紅綠燈、路型、便利商店，並與規劃出的路線用同一套方式比較。

/** 比對用的中性偏好：不避紅綠燈、不偏好任何路型，盡量貼著原軌跡 */
const NEUTRAL: RoutePreferences = { avoidSignals: false, sidewalk: 0, cycleway: 0, road: 0, trail: 0 };
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

/** 途經點與它在軌跡上的索引 */
interface Via extends LatLng {
  i: number;
}

/**
 * 逐段比對，找出「道路資料中走不過去」的路段：
 * 賽道常經過封閉園區、活動管制路段或 OSM 沒畫的小路，BRouter 只能繞一大圈（實測 115 m 繞成 7.7 km）。
 * 這種路段改用原軌跡本身，不再依賴道路資料。
 */
async function matchLegs(
  vias: Via[],
  pts: [number, number][],
  counter: CallCounter,
): Promise<{ raw: RawRoute; offTrackM: number }> {
  const limit = createLimiter(config.routerConcurrency);
  const legs = await Promise.all(vias.slice(1).map((v, k) => limit(() => route([vias[k], v], NEUTRAL, counter))));
  let offTrackM = 0;
  const parts = legs.map((leg, k): RawRoute => {
    const span = pts.slice(vias[k].i, vias[k + 1].i + 1);
    const spanLen = polylineLength(span);
    if (leg.trackLength <= spanLen * 1.5 + 100) return leg;
    offTrackM += spanLen;
    // 高度：兩端沿用 BRouter 的高度，中間線性內插
    const e0 = leg.coordinates[0][2];
    const e1 = leg.coordinates[leg.coordinates.length - 1][2];
    let acc = 0;
    const coordinates = span.map((p, j): [number, number, number] => {
      if (j > 0) acc += haversine(span[j - 1][1], span[j - 1][0], p[1], p[0]);
      return [p[0], p[1], e0 + (e1 - e0) * (spanLen ? acc / spanLen : 0)];
    });
    const end = span[span.length - 1];
    return {
      coordinates,
      trackLength: spanLen,
      messages: [{ lng: end[0], lat: end[1], distance: spanLen, wayTags: '', nodeTags: '' }],
    };
  });
  return { raw: parts.reduce((a, b) => mergeRoutes(a, b)), offTrackM };
}

/**
 * 以 GPX 內建高度取代 DEM 高度：依「沿路線距離比例」對應到原始軌跡上的位置。
 * 路線直線段的頂點很稀疏，先每 10 m 補點，否則中間的小起伏會被線性內插抹平。
 */
function applyGpxElevation(coords: [number, number, number][], src: [number, number, number][]) {
  const cum = [0];
  for (let i = 1; i < src.length; i++) cum.push(cum[i - 1] + haversine(src[i - 1][1], src[i - 1][0], src[i][1], src[i][0]));
  const routeLen = polylineLength(coords);
  const srcLen = cum[cum.length - 1];
  if (!routeLen || !srcLen) return coords;
  let j = 0;
  const eleAt = (d: number) => {
    const x = (d / routeLen) * srcLen;
    while (j < src.length - 2 && cum[j + 1] < x) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg ? Math.min(1, Math.max(0, (x - cum[j]) / seg)) : 0;
    return src[j][2] + (src[j + 1][2] - src[j][2]) * t;
  };
  const out: [number, number, number][] = [[coords[0][0], coords[0][1], eleAt(0)]];
  let acc = 0;
  for (let k = 1; k < coords.length; k++) {
    const [x0, y0] = coords[k - 1];
    const [x1, y1] = coords[k];
    const seg = haversine(y0, x0, y1, x1);
    const n = Math.floor(seg / 10);
    for (let m = 1; m <= n; m++) {
      const t = (m * 10) / seg;
      if (t < 1) out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, eleAt(acc + m * 10)]);
    }
    acc += seg;
    out.push([x1, y1, eleAt(acc)]);
  }
  return out;
}

export async function importTrack(
  req: ImportRequest,
  opts: { halfWindow?: number; spacing?: number } = {},
): Promise<ImportResponse> {
  const isTrack = req.source === 'track';
  // 沒有時間戳記的軌跡是規劃軟體畫出來的，本身就在路上且點稀疏：平滑只會把轉角削掉（實測少 2%）
  const recorded = isTrack && req.timed !== false;
  const src2d = req.points.map((p) => [p[0], p[1]] as [number, number]);
  const pts = recorded ? cleanTrack(src2d, opts.halfWindow) : src2d;
  const trackLen = polylineLength(pts);
  const gpxEle = req.points.every((p) => p.length > 2 && Number.isFinite(p[2]))
    ? (req.points as [number, number, number][])
    : null;

  const spacing = Math.max(opts.spacing ?? 100, trackLen / MAX_VIAS);
  const counter: CallCounter = { calls: 0 };

  /** 每隔 spacing 公尺取一個途經點（起終點一定保留） */
  const pickVias = (): Via[] => {
    const vias: Via[] = [{ lng: pts[0][0], lat: pts[0][1], i: 0 }];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      acc += haversine(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
      if (acc >= spacing) {
        vias.push({ lng: pts[i][0], lat: pts[i][1], i });
        acc = 0;
      }
    }
    // 終點：若最後一個途經點離終點太近，直接以終點取代，避免在終點前折返
    const n = pts.length - 1;
    const last = { lng: pts[n][0], lat: pts[n][1], i: n };
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

  let offTrackM = 0;
  const matchOnce = async (): Promise<RawRoute> => {
    let vias = pickVias();
    let raw = await matchVias(vias, counter);
    // 途經點被吸到路口延伸段、死巷或平行道路時會出現假的 U 字折返：
    // 去掉造成折返的途經點再比對（最多兩輪）。原始軌跡本身在該處往返（跑到底再回頭）則保留。
    // 實際紀錄的短折返（< 60 m）幾乎都是 GPS 飄移；規劃軌跡沒有飄移，短折返多半是真的折返點。
    for (let round = 0; round < 2; round++) {
      const bogus = findSpurs(raw.coordinates).filter(
        (sp) => (recorded && sp.lengthM < 60) || !trackPassesTwice(sp.mid, sp.lengthM * 0.5),
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
    // 比對結果明顯比軌跡長 → 有走不過去的路段，逐段找出來改用原軌跡
    if (raw.trackLength > trackLen * 1.03 + 100) {
      const fixed = await matchLegs(vias, pts, counter);
      if (fixed.raw.trackLength < raw.trackLength) {
        raw = fixed.raw;
        offTrackM = fixed.offTrackM;
      }
    }
    return raw;
  };

  const raw = isTrack ? await matchOnce() : await matchVias(pickVias(), counter);
  if (gpxEle) raw.coordinates = applyGpxElevation(raw.coordinates, gpxEle);

  const warnings: string[] = [];
  if (!isTrack) {
    warnings.push('此 GPX 只有路線點（rtept），已依道路連接各點；實際路徑可能與原規劃軟體不同');
  } else {
    if (offTrackM > 0) {
      warnings.push(
        `約 ${(offTrackM / 1000).toFixed(1)} km 在道路資料中走不過去（例如封閉園區、活動管制路段），該部分直接沿用原軌跡，紅綠燈與路型未計入`,
      );
    }
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
      ...routeMetrics(raw, gpxEle ? GPX_ELEVATION : DEM_ELEVATION),
      stores: storesAlongRoute(raw.coordinates),
      kind: 'imported',
      name: req.name,
    },
    warnings,
  };
}
