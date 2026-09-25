import type {
  GenerateRequest,
  GenerateResponse,
  LatLng,
  RoutePreferences,
  RouteResult,
  WayCategory,
} from '../../shared/types';
import { route, type CallCounter, type RawRoute } from './brouter';
import { config } from './config';
import { distLL } from './geo';
import { createLimiter } from './limiter';
import { overlapRatio, routeMetrics } from './metrics';
import { createRng, pickSign, randInt, randomSeed, uniform, type Rng } from './rng';
import { arcVias, perpendicularVia, type DetourShape } from './shapes';

export class UserError extends Error {}

type Metrics = ReturnType<typeof routeMetrics>;
type RouteFn = (pts: LatLng[], alt?: number, avoidClimb?: boolean) => Promise<RawRoute>;
type Spec = { d: number; extra: number; shape: DetourShape }[];

interface Candidate {
  raw: RawRoute;
  m: Metrics;
  kind: RouteResult['kind'];
  lengthError?: number;
  score: number;
}

const TARGET_TOLERANCE = 0.03;
const MAX_ITERATIONS = 4;
const TARGET_CANDIDATES = 8;
const SHORTEST_RANDOM_CANDIDATES = 5;
const SNAP_LIMIT_M = 300;
/** 自訂爬升時，第二輪由最接近目標的幾條候選變化出來的數量 */
const CLIMB_REFINE_PARENTS = 3;
const CLIMB_REFINE_CANDIDATES = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export async function generateRoutes(req: GenerateRequest): Promise<GenerateResponse> {
  const t0 = Date.now();
  const seed = req.seed ?? randomSeed();
  const rng = createRng(seed);
  const counter: CallCounter = { calls: 0 };
  const limit = createLimiter(config.routerConcurrency);
  const count = clamp(req.count ?? 3, 1, 5);
  const warnings: string[] = [];
  const exclude = req.exclude ?? [];

  if (!req.loop && !req.end) throw new UserError('請設定終點，或勾選「環狀路線」');
  const anchors: LatLng[] = [req.start, ...req.waypoints, req.loop ? req.start : req.end!];
  const pureLoop = req.loop && req.waypoints.length === 0;

  const climbTarget = req.climb?.targetM ?? null;
  const doRoute: RouteFn = (pts, alt = 0, avoidClimb = false) =>
    limit(() => route(pts, { ...req.prefs, avoidClimb }, counter, alt));
  const evaluate = (raw: RawRoute, kind: Candidate['kind']): Candidate => ({
    raw,
    m: routeMetrics(raw),
    kind,
    score: 0,
  });

  let base: Candidate | null = null;
  if (!pureLoop) {
    base = evaluate(await doRoute(anchors), 'shortest');
    checkSnapping(base.raw, req);
  }

  let candidates: Candidate[];
  let forced: Candidate[] = [];
  const targetM = req.distance.mode === 'target' ? req.distance.km * 1000 : null;

  if (targetM === null || (base && targetM < base.m.distanceM * 0.97)) {
    if (pureLoop) throw new UserError('環狀路線請指定距離，或新增至少一個經過點');
    if (targetM !== null) {
      warnings.push(
        `指定距離 ${(targetM / 1000).toFixed(1)} km 短於最短路徑 ${(base!.m.distanceM / 1000).toFixed(2)} km，已改為最短路徑模式`,
      );
    }
    candidates = await shortestCandidates(anchors, base!, rng, doRoute, evaluate);
    // 自訂爬升且所有候選都爬太多：改用「減少爬升」的 profile 再規劃一次
    if (climbTarget !== null && Math.min(...candidates.map((c) => c.m.ascentM)) > climbTarget * 1.25 + 5) {
      const flatter = await Promise.all(
        [0, 1, 2].map((alt) =>
          doRoute(anchors, alt, true).then(
            (r) => evaluate(r, alt ? 'alternative' : 'shortest'),
            () => null,
          ),
        ),
      );
      candidates.push(...flatter.filter((c): c is Candidate => c !== null));
    }
    for (const c of candidates) c.score = scoreShortest(c, base!, req.prefs, climbTarget, rng);
    // 沒有自訂爬升時，真正的最短路徑永遠列為第一條（除非它與已鎖定路線重複）
    if (climbTarget === null && !exclude.some((g) => overlapRatio(base!.raw.coordinates, g) > 0.85)) {
      forced = [base!];
    }
  } else {
    candidates = await targetCandidates(anchors, base, targetM, pureLoop, climbTarget, rng, doRoute, evaluate);
    if (candidates.length === 0) {
      throw new UserError('無法產生符合條件的路線，請換個起點或調整距離');
    }
    for (const c of candidates) {
      checkSnapping(c.raw, req);
      c.score = scoreTarget(c, req.prefs, climbTarget);
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const selected = selectDiverse(candidates, count, forced, exclude);
  const offTarget = selected.filter((c) => Math.abs(c.lengthError ?? 0) > 0.08).length;
  if (offTarget > 0) {
    warnings.push(`附近路網有限，有 ${offTarget} 條路線與指定距離誤差超過 8%`);
  }
  if (selected.some((c) => c.m.selfOverlap > 0.4)) {
    warnings.push('附近路網較稀疏，部分路線需要折返（見「重複路段」）');
  }
  if (climbTarget !== null && selected.length > 0) {
    const closest = selected.reduce((a, b) =>
      Math.abs(a.m.ascentM - climbTarget) <= Math.abs(b.m.ascentM - climbTarget) ? a : b,
    );
    if (Math.abs(closest.m.ascentM - climbTarget) > Math.max(climbTarget * 0.3, 15)) {
      warnings.push(
        `附近地形難以達到目標總爬升 ${climbTarget} m，最接近的路線為 ${Math.round(closest.m.ascentM)} m`,
      );
    }
  }
  if (selected.length < count) {
    warnings.push(`只找到 ${selected.length} 條差異足夠的路線`);
  }

  const routes: RouteResult[] = selected.map((c, i) => ({
    id: `${seed.toString(36)}-${i}`,
    coordinates: c.raw.coordinates,
    ...c.m,
    lengthError: c.lengthError,
    kind: c.kind,
  }));

  return {
    seed,
    climbTargetM: climbTarget ?? undefined,
    routes,
    warnings,
    stats: { candidates: candidates.length, routerCalls: counter.calls, ms: Date.now() - t0 },
  };
}

function checkSnapping(raw: RawRoute, req: GenerateRequest) {
  const c = raw.coordinates;
  const first = { lng: c[0][0], lat: c[0][1] };
  const last = { lng: c[c.length - 1][0], lat: c[c.length - 1][1] };
  if (distLL(first, req.start) > SNAP_LIMIT_M) {
    throw new UserError('起點附近 300 公尺內找不到可通行的道路，請換個位置');
  }
  if (!req.loop && req.end && distLL(last, req.end) > SNAP_LIMIT_M) {
    throw new UserError('終點附近 300 公尺內找不到可通行的道路，請換個位置');
  }
}

// ---------- 最短路徑模式 ----------

async function shortestCandidates(
  anchors: LatLng[],
  base: Candidate,
  rng: Rng,
  doRoute: RouteFn,
  evaluate: (raw: RawRoute, kind: Candidate['kind']) => Candidate,
): Promise<Candidate[]> {
  const jobs: Promise<Candidate | null>[] = [];

  // BRouter 內建替代路線
  for (const alt of [1, 2, 3]) {
    jobs.push(doRoute(anchors, alt).then((r) => evaluate(r, 'alternative'), () => null));
  }

  // 隨機微擾：在較長的路段中間往側邊偏移一個途經點
  const segIdx = anchors
    .slice(0, -1)
    .map((a, i) => ({ i, d: distLL(a, anchors[i + 1]) }))
    .filter((s) => s.d > 300);
  if (segIdx.length > 0) {
    for (let n = 0; n < SHORTEST_RANDOM_CANDIDATES; n++) {
      const seg = segIdx[randInt(rng, 0, segIdx.length - 1)];
      const A = anchors[seg.i];
      const B = anchors[seg.i + 1];
      const via = perpendicularVia(
        A,
        B,
        uniform(rng, 0.3, 0.7),
        pickSign(rng) * seg.d * uniform(rng, 0.08, 0.3),
      );
      const pts = [...anchors.slice(0, seg.i + 1), via, ...anchors.slice(seg.i + 1)];
      jobs.push(doRoute(pts).then((r) => evaluate(r, 'random'), () => null));
    }
  }

  const results = (await Promise.all(jobs)).filter((c): c is Candidate => c !== null);
  // 去除與最短路徑幾乎相同的候選
  return [base, ...results.filter((c) => overlapRatio(c.raw.coordinates, base.raw.coordinates) < 0.92)];
}

function scoreShortest(
  c: Candidate,
  base: Candidate,
  prefs: RoutePreferences,
  climbTarget: number | null,
  rng: Rng,
): number {
  const extra = c.m.distanceM / base.m.distanceM - 1;
  return (
    extra * 4 +
    climbScore(c, climbTarget) +
    c.m.selfOverlap * 3 +
    signalScore(c, prefs) +
    preferenceScore(c.m.breakdown, prefs) +
    rng() * 0.3 // 讓「重新產生」時替代路線的挑選有變化
  );
}

// ---------- 指定距離模式 ----------

function randomShape(rng: Rng): DetourShape {
  return {
    side: pickSign(rng) as 1 | -1,
    rotation: uniform(rng, 0, 2 * Math.PI),
    clockwise: rng() < 0.5,
    extraPoints: rng() < 0.3 ? 1 : 0,
    radial: Array.from({ length: 6 }, () => uniform(rng, 0.85, 1.15)),
    along: Array.from({ length: 6 }, () => uniform(rng, -0.1, 0.1)),
  };
}

async function targetCandidates(
  anchors: LatLng[],
  base: Candidate | null,
  targetM: number,
  pureLoop: boolean,
  climbTarget: number | null,
  rng: Rng,
  doRoute: RouteFn,
  evaluate: (raw: RawRoute, kind: Candidate['kind']) => Candidate,
): Promise<Candidate[]> {
  const segD = anchors.slice(0, -1).map((a, i) => distLL(a, anchors[i + 1]));
  const sumD = segD.reduce((s, d) => s + d, 0);
  const baseLen = base?.m.distanceM ?? 0;
  // 路網繞行係數：實際路線長 / 直線距離
  const detourFactor = base && sumD > 100 ? clamp(baseLen / sumD, 1.1, 2) : 1.3;
  const slack = targetM - baseLen;

  // 事先以 rng 決定所有候選的形狀（確保同一種子可重現）
  const makeSpec = (): Spec => {
    const weights = segD.map((d) => (pureLoop ? 1 : d + 200) * uniform(rng, 0.2, 1.8));
    if (weights.length > 1) {
      for (let i = 0; i < weights.length; i++) if (rng() < 0.35) weights[i] = 0;
      if (weights.reduce((s, w) => s + w, 0) === 0) weights[randInt(rng, 0, weights.length - 1)] = 1;
    }
    const sumW = weights.reduce((s, w) => s + w, 0);
    return segD.map((d, i) => ({
      d,
      extra: (slack * weights[i]) / sumW,
      shape: randomShape(rng),
    }));
  };

  // 由既有候選微調形狀（方位、凸出側、半徑…），用於往目標爬升靠近
  const mutateSpec = (spec: Spec): Spec =>
    spec.map((seg) => ({
      d: seg.d,
      extra: seg.extra,
      shape: {
        ...seg.shape,
        side: rng() < 0.85 ? seg.shape.side : ((-seg.shape.side) as 1 | -1),
        rotation: seg.shape.rotation + uniform(rng, -0.5, 0.5),
        clockwise: rng() < 0.8 ? seg.shape.clockwise : !seg.shape.clockwise,
        radial: seg.shape.radial.map((r) => clamp(r * uniform(rng, 0.9, 1.1), 0.75, 1.25)),
        along: seg.shape.along.map((a) => clamp(a + uniform(rng, -0.05, 0.05), -0.15, 0.15)),
      },
    }));

  const buildPoints = (spec: Spec, lambda: number): LatLng[] => {
    const pts: LatLng[] = [];
    spec.forEach((seg, i) => {
      const A = anchors[i];
      const B = anchors[i + 1];
      pts.push(A);
      const s = seg.d + (lambda * seg.extra) / detourFactor;
      if (s > seg.d * 1.05 + 80) pts.push(...arcVias(A, B, s, seg.shape));
    });
    pts.push(anchors[anchors.length - 1]);
    return pts;
  };

  const runSpec = async (spec: Spec, avoidClimb: boolean): Promise<Candidate | null> => {
    let lambda = 1;
    const history: [number, number][] = [[0, baseLen]];
    let best: { raw: RawRoute; err: number } | null = null;
    for (let it = 0; it < MAX_ITERATIONS; it++) {
      let raw: RawRoute;
      try {
        raw = await doRoute(buildPoints(spec, lambda), 0, avoidClimb);
      } catch (err) {
        // 第一次就失敗：交給上層記錄錯誤；之後失敗：保留目前最好的結果
        if (!best) throw err;
        break;
      }
      const len = raw.trackLength;
      const err = Math.abs(len - targetM) / targetM;
      if (!best || err < best.err) best = { raw, err };
      if (err <= TARGET_TOLERANCE) break;
      history.push([lambda, len]);
      // 割線法：以最近兩次 (lambda, 長度) 推估達到目標長度的 lambda
      const [l1, y1] = history[history.length - 2];
      const [l2, y2] = history[history.length - 1];
      let next = y2 !== y1 ? l2 + ((targetM - y2) * (l2 - l1)) / (y2 - y1) : l2 * (targetM / y2);
      if (!Number.isFinite(next) || next <= 0) next = lambda * (targetM / len);
      lambda = clamp(next, 0.05, 8);
    }
    if (!best) return null;
    const c = evaluate(best.raw, 'random');
    c.lengthError = (best.raw.trackLength - targetM) / targetM;
    return c;
  };

  const errors: unknown[] = [];
  const runAll = async (specs: Spec[], avoidClimb: boolean) => {
    const results = await Promise.all(
      specs.map((spec) =>
        runSpec(spec, avoidClimb).then(
          (c) => (c ? { spec, c } : null),
          (err) => {
            errors.push(err);
            return null;
          },
        ),
      ),
    );
    return results.filter((r): r is { spec: Spec; c: Candidate } => r !== null);
  };

  const round1 = await runAll(Array.from({ length: TARGET_CANDIDATES }, makeSpec), false);
  // 全部失敗時把 BRouter 的真正錯誤往上丟，而不是只顯示籠統訊息
  if (round1.length === 0 && errors.length > 0) throw errors[0];

  if (climbTarget === null || round1.length === 0) return round1.map((r) => r.c);

  // 第二輪：從爬升最接近目標的候選變化出新候選；全部都爬太多時改用「減少爬升」profile
  const climbErr = (c: Candidate) =>
    Math.abs(c.m.ascentM - climbTarget) + (Math.abs(c.lengthError ?? 0) > 0.08 ? 1e6 : 0);
  const parents = [...round1].sort((a, b) => climbErr(a.c) - climbErr(b.c)).slice(0, CLIMB_REFINE_PARENTS);
  const tooMuchClimb = Math.min(...round1.map((r) => r.c.m.ascentM)) > climbTarget * 1.25 + 5;
  const childSpecs = Array.from({ length: CLIMB_REFINE_CANDIDATES }, (_, i) =>
    mutateSpec(parents[i % parents.length].spec),
  );
  const round2 = await runAll(childSpecs, tooMuchClimb);
  return [...round1, ...round2].map((r) => r.c);
}

function scoreTarget(c: Candidate, prefs: RoutePreferences, climbTarget: number | null): number {
  const err = Math.abs(c.lengthError ?? 0);
  return (
    err * 12 +
    climbScore(c, climbTarget) +
    (err > 0.08 ? 20 : 0) + // 距離是主要條件，誤差過大的候選一律排在後面
    c.m.selfOverlap * 3 +
    signalScore(c, prefs) +
    preferenceScore(c.m.breakdown, prefs)
  );
}

// ---------- 共用評分 ----------

/** 爬升只需「大概符合」：相對誤差線性計分並設上限，距離仍是主要條件 */
function climbScore(c: Candidate, climbTarget: number | null): number {
  if (climbTarget === null) return 0;
  const rel = Math.abs(c.m.ascentM - climbTarget) / Math.max(climbTarget, 20);
  return Math.min(12, rel * 3);
}

function signalScore(c: Candidate, prefs: RoutePreferences): number {
  if (!prefs.avoidSignals) return 0;
  const km = Math.max(0.5, c.m.distanceM / 1000);
  return (c.m.signals.length / km) * 0.35;
}

function preferenceScore(b: Record<WayCategory, number>, prefs: RoutePreferences): number {
  const total = b.sidewalk + b.cycleway + b.road || 1;
  const cats: WayCategory[] = ['sidewalk', 'cycleway', 'road'];
  let penalty = 0;
  let preferredShare = 0;
  let anyPreferred: boolean = false;
  for (const cat of cats) {
    const share = b[cat] / total;
    if (prefs[cat] === -1) penalty += share * 1.5;
    if (prefs[cat] === 1) {
      anyPreferred = true;
      preferredShare += share;
    }
  }
  if (anyPreferred) penalty += (1 - preferredShare) * 0.8;
  return penalty;
}

/** 依分數由好到壞挑選，並要求彼此重疊率低於門檻；找不夠時逐步放寬 */
function selectDiverse(
  sorted: Candidate[],
  count: number,
  forced: Candidate[],
  exclude: [number, number][][],
): Candidate[] {
  const chosen = [...forced].slice(0, count);
  const overlapCache = new Map<string, number>();
  const overlap = (a: Candidate, b: Candidate) => {
    const key = `${sorted.indexOf(a)}|${sorted.indexOf(b)}`;
    let v = overlapCache.get(key);
    if (v === undefined) {
      v = Math.max(
        overlapRatio(a.raw.coordinates, b.raw.coordinates),
        overlapRatio(b.raw.coordinates, a.raw.coordinates),
      );
      overlapCache.set(key, v);
    }
    return v;
  };
  for (const threshold of [0.45, 0.6, 0.75, 0.9]) {
    for (const c of sorted) {
      if (chosen.length >= count) return chosen;
      if (chosen.includes(c)) continue;
      const okChosen = chosen.every((x) => overlap(c, x) < threshold);
      const okExcluded = exclude.every((g) => overlapRatio(c.raw.coordinates, g) < threshold);
      if (okChosen && okExcluded) chosen.push(c);
    }
  }
  return chosen;
}
