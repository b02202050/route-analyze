import type { ElevationPoint, WayCategory, WayRun } from '../../shared/types';
import type { RawRoute, RouteMessage } from './brouter';
import { haversine, PointGrid, resample, type Sample } from './geo';

// ---------- 爬升 / 下降 ----------

/**
 * 從高度序列計算總爬升與總下降。
 * DEM（SRTM 90m）有雜訊，直接累加會高估，所以：
 * 1) 每 step 公尺重新取樣  2) 移動平均平滑  3) 遲滯門檻（小於 threshold 的起伏不計）
 */
export function computeElevation(
  coords: [number, number, number][],
  opts = { step: 20, window: 5, threshold: 2 },
) {
  const samples = resample(coords, opts.step);
  if (samples.length < 2) {
    const e = samples[0]?.ele ?? 0;
    return { ascent: 0, descent: 0, min: e, max: e, smoothed: samples };
  }
  const half = Math.floor(opts.window / 2);
  const smoothed: Sample[] = samples.map((s, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(samples.length - 1, i + half); j++) {
      sum += samples[j].ele;
      n++;
    }
    return { ...s, ele: sum / n };
  });

  let ascent = 0;
  let descent = 0;
  let ref = smoothed[0].ele;
  for (const s of smoothed) {
    const diff = s.ele - ref;
    if (diff >= opts.threshold) {
      ascent += diff;
      ref = s.ele;
    } else if (-diff >= opts.threshold) {
      descent -= diff;
      ref = s.ele;
    }
  }
  // 最後一段不足門檻的變化也算進去，讓「爬升 − 下降 ≈ 終點高度 − 起點高度」
  const tail = smoothed[smoothed.length - 1].ele - ref;
  if (tail > 0) ascent += tail;
  else descent -= tail;

  let min = Infinity;
  let max = -Infinity;
  for (const s of smoothed) {
    min = Math.min(min, s.ele);
    max = Math.max(max, s.ele);
  }
  return { ascent, descent, min, max, smoothed };
}

export function downsampleProfile(samples: Sample[], maxPoints = 300): ElevationPoint[] {
  const stride = Math.max(1, Math.ceil(samples.length / maxPoints));
  const out: ElevationPoint[] = [];
  for (let i = 0; i < samples.length; i += stride) {
    out.push({ d: Math.round(samples[i].d), e: Math.round(samples[i].ele * 10) / 10 });
  }
  const last = samples[samples.length - 1];
  if (last && out[out.length - 1]?.d !== Math.round(last.d)) {
    out.push({ d: Math.round(last.d), e: Math.round(last.ele * 10) / 10 });
  }
  return out;
}

// ---------- 紅綠燈 ----------

const SIGNAL_RE = /(^|\s)(highway=traffic_signals|crossing=traffic_signals)/;

/** 從 BRouter messages 取出號誌節點，並把 radius 內的多個號誌合併成同一路口 */
export function extractSignals(messages: RouteMessage[], radius = 35): [number, number][] {
  const clusters: { lat: number; lng: number; n: number }[] = [];
  for (const m of messages) {
    if (!SIGNAL_RE.test(m.nodeTags)) continue;
    const hit = clusters.find((c) => haversine(c.lat, c.lng, m.lat, m.lng) <= radius);
    if (hit) {
      hit.lat = (hit.lat * hit.n + m.lat) / (hit.n + 1);
      hit.lng = (hit.lng * hit.n + m.lng) / (hit.n + 1);
      hit.n++;
    } else {
      clusters.push({ lat: m.lat, lng: m.lng, n: 1 });
    }
  }
  return clusters.map((c) => [c.lng, c.lat]);
}

// ---------- 路型分類（須與 running.brf 的分類一致） ----------

function parseTags(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const kv of s.split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i > 0) m.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return m;
}

const FOOT_HIGHWAYS = new Set([
  'footway', 'pedestrian', 'path', 'steps', 'living_street', 'corridor', 'platform', 'track', 'bridleway',
]);

export function classifyWay(wayTags: string): WayCategory {
  const t = parseTags(wayTags);
  const hw = t.get('highway') ?? '';
  const isCycle =
    hw === 'cycleway' ||
    ((hw === 'path' || hw === 'footway') && t.get('bicycle') === 'designated') ||
    t.get('cycleway') === 'track';
  if (isCycle) return 'cycleway';
  if (FOOT_HIGHWAYS.has(hw)) return 'sidewalk';
  const sw = t.get('sidewalk');
  if (sw && ['left', 'right', 'both', 'yes'].includes(sw)) return 'sidewalk';
  for (const k of ['sidewalk:left', 'sidewalk:right', 'sidewalk:both']) {
    const v = t.get(k);
    if (v === 'yes' || v === 'separate') return 'sidewalk';
  }
  return 'road';
}

export function computeBreakdown(messages: RouteMessage[]): Record<WayCategory, number> {
  const out: Record<WayCategory, number> = { sidewalk: 0, cycleway: 0, road: 0 };
  for (const m of messages) out[classifyWay(m.wayTags)] += m.distance;
  return out;
}

/**
 * 把路型對應到座標索引區段。
 * BRouter 的每個 message 位於路線上的某個座標點，其 WayTags 描述「上一個 message 點 → 此點」這一段。
 */
export function computeWayRuns(coords: [number, number, number][], messages: RouteMessage[]): WayRun[] {
  const runs: WayRun[] = [];
  if (coords.length < 2) return runs;
  const EPS = 2e-6;
  let prev = 0;
  let j = 0;
  for (const m of messages) {
    // 往後找到與 message 相同的座標點；找不到（理論上不會發生）就取之後最近的點
    let k = j;
    while (k < coords.length && (Math.abs(coords[k][0] - m.lng) > EPS || Math.abs(coords[k][1] - m.lat) > EPS)) k++;
    if (k >= coords.length) {
      let best = j;
      let bestD = Infinity;
      for (let i = j; i < coords.length; i++) {
        const d = haversine(coords[i][1], coords[i][0], m.lat, m.lng);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      k = best;
    }
    if (k > prev) {
      const category = classifyWay(m.wayTags);
      const last = runs[runs.length - 1];
      if (last && last.category === category && last.to === prev) last.to = k;
      else runs.push({ category, from: prev, to: k });
      prev = k;
    }
    j = k;
  }
  // 最後一個 message 之後若還有座標，沿用最後的路型
  if (prev < coords.length - 1 && runs.length) {
    const last = runs[runs.length - 1];
    if (last.to === prev) last.to = coords.length - 1;
    else runs.push({ category: last.category, from: prev, to: coords.length - 1 });
  }
  return runs;
}

// ---------- 重疊 ----------

/**
 * 路線自我重疊（折返）比例：重新取樣後，若某點附近有「沿路線距離相差很遠」的另一點，
 * 代表同一段路跑了兩次。起點附近（環狀路線自然會回來）不計。
 */
export function selfOverlap(coords: [number, number, number][], step = 20, radius = 15): number {
  const s = resample(coords, step);
  if (s.length < 10) return 0;
  const grid = new PointGrid(radius * 2, s[0]);
  s.forEach((p, i) => grid.add(p.lat, p.lng, i));
  const minGap = Math.ceil(150 / step);
  let overlap = 0;
  let counted = 0;
  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    if (haversine(p.lat, p.lng, s[0].lat, s[0].lng) < 60) continue;
    counted++;
    if (grid.hasNear(p.lat, p.lng, radius, (j) => Math.abs(j - i) > minGap)) overlap++;
  }
  return counted ? overlap / counted : 0;
}

/** a 路線有多少比例落在 b 路線附近 */
export function overlapRatio(
  a: [number, number, number][] | [number, number][],
  b: [number, number, number][] | [number, number][],
  radius = 20,
): number {
  const toC = (c: number[][]) => c.map((p) => [p[0], p[1], 0] as [number, number, number]);
  const sa = resample(toC(a), 25);
  const sb = resample(toC(b), 10);
  if (!sa.length || !sb.length) return 0;
  const grid = new PointGrid(radius * 2, sb[0]);
  for (const p of sb) grid.add(p.lat, p.lng);
  let hit = 0;
  for (const p of sa) if (grid.hasNear(p.lat, p.lng, radius)) hit++;
  return hit / sa.length;
}

export function routeMetrics(raw: RawRoute) {
  const elev = computeElevation(raw.coordinates);
  const signals = extractSignals(raw.messages);
  return {
    distanceM: raw.trackLength,
    ascentM: elev.ascent,
    descentM: elev.descent,
    minEleM: elev.min,
    maxEleM: elev.max,
    elevationProfile: downsampleProfile(elev.smoothed),
    signals,
    breakdown: computeBreakdown(raw.messages),
    wayRuns: computeWayRuns(raw.coordinates, raw.messages),
    selfOverlap: selfOverlap(raw.coordinates),
  };
}
