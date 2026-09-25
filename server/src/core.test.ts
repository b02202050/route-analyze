import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distLL } from './geo';
import { classifyWay, computeElevation, computeWayRuns, extractSignals, overlapRatio, selfOverlap } from './metrics';
import { createRng } from './rng';
import { arcVias, solveArcAngle, type DetourShape } from './shapes';
import type { RouteMessage } from './brouter';
import { loadStoresFromOverpass, storesAlongRoute } from './stores';

const flatShape: DetourShape = {
  side: 1,
  rotation: 0.7,
  clockwise: false,
  extraPoints: 0,
  radial: [1, 1, 1, 1, 1, 1],
  along: [0, 0, 0, 0, 0, 0],
};

test('solveArcAngle: 弧長/弦長比例', () => {
  for (const ratio of [1.01, 1.2, 1.57, 3, 10]) {
    const phi = solveArcAngle(ratio);
    assert.ok(Math.abs(phi / (2 * Math.sin(phi / 2)) - ratio) < 1e-6);
  }
});

test('arcVias: 途經點折線長度接近目標（弦長略短於弧長）', () => {
  const A = { lat: 24.99, lng: 121.31 };
  const B = { lat: 24.995, lng: 121.29 };
  for (const s of [2500, 5000, 10000]) {
    const pts = [A, ...arcVias(A, B, s, flatShape), B];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += distLL(pts[i - 1], pts[i]);
    assert.ok(len <= s * 1.001 && len > s * 0.8, `s=${s} len=${len}`);
  }
});

test('arcVias: A 與 B 重合時產生繞圈', () => {
  const A = { lat: 24.99, lng: 121.31 };
  const pts = [A, ...arcVias(A, A, 6000, flatShape), A];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += distLL(pts[i - 1], pts[i]);
  // 內接正方形周長 ≈ 0.9 × 圓周
  assert.ok(len > 6000 * 0.85 && len < 6000, `len=${len}`);
});

test('computeElevation: 雜訊不會灌水爬升', () => {
  const rng = createRng(42);
  const coords: [number, number, number][] = [];
  // 5 km 平路，±1.5 m 雜訊，中間一座 30 m 的小坡
  for (let i = 0; i <= 500; i++) {
    const hill = i > 200 && i < 300 ? 30 * Math.sin(((i - 200) / 100) * Math.PI) : 0;
    coords.push([121.3 + i * 0.0001, 25, 50 + hill + (rng() - 0.5) * 3]);
  }
  const { ascent, descent } = computeElevation(coords);
  assert.ok(ascent > 25 && ascent < 40, `ascent=${ascent}`);
  assert.ok(descent > 25 && descent < 40, `descent=${descent}`);
});

test('extractSignals: 同一路口的多個號誌合併計算', () => {
  const m = (lat: number, lng: number, nodeTags: string): RouteMessage => ({
    lat, lng, nodeTags, distance: 10, wayTags: '',
  });
  const msgs = [
    m(25.0, 121.3, 'highway=traffic_signals'),
    m(25.0001, 121.3001, 'highway=traffic_signals'),
    m(25.0002, 121.3, 'crossing=traffic_signals'),
    m(25.01, 121.3, 'highway=traffic_signals'),
    m(25.02, 121.3, 'highway=crossing'),
  ];
  assert.equal(extractSignals(msgs).length, 2);
});

test('classifyWay', () => {
  assert.equal(classifyWay('highway=cycleway surface=asphalt'), 'cycleway');
  assert.equal(classifyWay('highway=path bicycle=designated'), 'cycleway');
  assert.equal(classifyWay('highway=footway footway=sidewalk'), 'sidewalk');
  assert.equal(classifyWay('highway=residential sidewalk=both'), 'sidewalk');
  assert.equal(classifyWay('highway=primary sidewalk=no'), 'road');
  assert.equal(classifyWay('highway=service'), 'road');
});

test('overlap: 來回折返與不同路線', () => {
  const out: [number, number, number][] = [];
  for (let i = 0; i <= 100; i++) out.push([121.3 + i * 0.0001, 25, 0]);
  const outAndBack = [...out, ...[...out].reverse()];
  assert.ok(selfOverlap(outAndBack) > 0.8);
  assert.ok(selfOverlap(out) < 0.05);
  const parallelFar = out.map(([x, y]) => [x, y + 0.01, 0] as [number, number, number]);
  assert.ok(overlapRatio(out, out) > 0.95);
  assert.ok(overlapRatio(out, parallelFar) < 0.05);
});

test('computeWayRuns: 依 message 位置切出路型區段並合併相鄰同類', () => {
  const coords: [number, number, number][] = Array.from({ length: 7 }, (_, i) => [121 + i * 0.001, 25, 0]);
  const m = (i: number, wayTags: string): RouteMessage => ({
    lng: coords[i][0], lat: coords[i][1], distance: 100, wayTags, nodeTags: '',
  });
  const runs = computeWayRuns(coords, [
    m(2, 'highway=footway'),
    m(3, 'highway=pedestrian'),
    m(5, 'highway=cycleway'),
    m(6, 'highway=primary'),
  ]);
  assert.deepEqual(runs, [
    { category: 'sidewalk', from: 0, to: 3 },
    { category: 'cycleway', from: 3, to: 5 },
    { category: 'road', from: 5, to: 6 },
  ]);
});

test('storesAlongRoute: 100 m 內、依沿路距離排序、排除蝦皮、辨識品牌、環狀只算第一次', () => {
  // 往東 2 km 再原路折返
  const out: [number, number, number][] = [];
  for (let i = 0; i <= 200; i++) out.push([121.3 + i * 0.0001, 25, 0]);
  const route = [...out, ...[...out].reverse()];
  loadStoresFromOverpass({
    elements: [
      { type: 'node', lat: 25.0005, lon: 121.3150, tags: { name: '全家便利商店', brand: '全家便利商店', branch: '測試店' } },
      { type: 'node', lat: 25.0003, lon: 121.3050, tags: { name: '7-Eleven', brand: '7-Eleven', opening_hours: '24/7' } },
      { type: 'node', lat: 25.0100, lon: 121.3100, tags: { name: '萊爾富' } }, // 約 1.1 km 外
      { type: 'node', lat: 25.0002, lon: 121.3100, tags: { name: '蝦皮店到店' } },
      { type: 'way', center: { lat: 24.9996, lon: 121.3180 }, tags: { name: 'OK超商' } },
    ],
  });
  const s = storesAlongRoute(route);
  assert.deepEqual(s.map((x) => x.brand), ['seven', 'family', 'ok']);
  assert.equal(s[1].name, '全家便利商店 測試店');
  assert.equal(s[0].openingHours, '24/7');
  // 第一次經過時就記錄，不會因回程再經過而變成約 3.5 km 處
  assert.ok(s[0].alongM > 400 && s[0].alongM < 600, `alongM=${s[0].alongM}`);
  assert.ok(s[0].offsetM < 60);
});
