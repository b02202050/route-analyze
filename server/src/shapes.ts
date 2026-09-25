import type { LatLng } from '../../shared/types';
import { LocalProjection } from './geo';

/** 單一路段的繞路形狀參數（由隨機產生，迭代時固定，只縮放 extra） */
export interface DetourShape {
  /** 1 或 -1：往路段左側或右側繞 */
  side: 1 | -1;
  /** 環狀路線的方位角（rad） */
  rotation: number;
  /** 環狀路線繞圈方向 */
  clockwise: boolean;
  /** 額外的途經點數量加成（0 或 1） */
  extraPoints: number;
  /** 每個途經點的半徑抖動係數（0.85 ~ 1.15） */
  radial: number[];
  /** 每個途經點沿弧線位置的抖動（± 0.1） */
  along: number[];
}

/** 解 φ / (2 sin(φ/2)) = ratio，φ ∈ (0, 2π)。弧長 / 弦長 = ratio */
export function solveArcAngle(ratio: number): number {
  if (ratio <= 1) return 1e-6;
  let lo = 1e-6;
  let hi = 2 * Math.PI - 1e-6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const g = mid / (2 * Math.sin(mid / 2));
    if (g < ratio) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * 在 A→B 之間產生途經點，使 A → vias → B 的直線總長約為 s（公尺）。
 * - A、B 距離很近（環狀）：途經點落在一個通過 A、周長為 s 的圓上。
 * - 否則：途經點落在一段通過 A、B、弧長為 s 的圓弧上（往 side 側凸出）。
 *   s 只比 AB 略長時弧線很扁；s 很長時弧線接近一個大圓，形成繞圈。
 */
export function arcVias(A: LatLng, B: LatLng, s: number, shape: DetourShape): LatLng[] {
  const proj = new LocalProjection(A);
  const [bx, by] = proj.toXY(B);
  const d = Math.hypot(bx, by);
  const pts: LatLng[] = [];

  if (d < 30) {
    const R = s / (2 * Math.PI);
    const cx = R * Math.cos(shape.rotation);
    const cy = R * Math.sin(shape.rotation);
    const start = shape.rotation + Math.PI;
    const dir = shape.clockwise ? -1 : 1;
    const k = 3 + shape.extraPoints;
    for (let j = 1; j <= k; j++) {
      const t = (j + (shape.along[j - 1] ?? 0)) / (k + 1);
      const theta = start + dir * 2 * Math.PI * t;
      const r = R * (shape.radial[j - 1] ?? 1);
      pts.push(proj.toLL(cx + r * Math.cos(theta), cy + r * Math.sin(theta)));
    }
    return pts;
  }

  const phi = solveArcAngle(s / d);
  const R = d / (2 * Math.sin(phi / 2));
  const ux = bx / d;
  const uy = by / d;
  const nx = -uy * shape.side;
  const ny = ux * shape.side;
  const h = R * Math.cos(phi / 2);
  const cx = bx / 2 - nx * h;
  const cy = by / 2 - ny * h;
  const alphaA = Math.atan2(-cy, -cx);
  const alphaBulge = Math.atan2(ny, nx); // 凸出點 = center + n·R
  const dir = Math.sign(wrap(alphaBulge - alphaA)) || 1;
  const k = Math.min(5, Math.max(1, Math.round(phi / (Math.PI / 2))) + shape.extraPoints);
  for (let j = 1; j <= k; j++) {
    const t = (j + (shape.along[j - 1] ?? 0)) / (k + 1);
    const theta = alphaA + dir * phi * t;
    const r = R * (shape.radial[j - 1] ?? 1);
    pts.push(proj.toLL(cx + r * Math.cos(theta), cy + r * Math.sin(theta)));
  }
  return pts;
}

/** 在 A→B 路段中段往側邊偏移一點（用於最短路徑模式的隨機替代路線） */
export function perpendicularVia(A: LatLng, B: LatLng, t: number, offset: number): LatLng {
  const proj = new LocalProjection(A);
  const [bx, by] = proj.toXY(B);
  const d = Math.hypot(bx, by) || 1;
  return proj.toLL(bx * t + (-by / d) * offset, by * t + (bx / d) * offset);
}
