import type { LatLng } from '../../shared/types';

const R = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const distLL = (a: LatLng, b: LatLng) => haversine(a.lat, a.lng, b.lat, b.lng);

/** 以 origin 為原點的等距平面投影（公尺），路跑尺度（< 50 km）誤差可忽略 */
export class LocalProjection {
  private readonly kx: number;
  private readonly ky = (Math.PI * R) / 180;
  constructor(private readonly origin: LatLng) {
    this.kx = this.ky * Math.cos(toRad(origin.lat));
  }
  toXY(p: LatLng): [number, number] {
    return [(p.lng - this.origin.lng) * this.kx, (p.lat - this.origin.lat) * this.ky];
  }
  toLL(x: number, y: number): LatLng {
    return { lat: this.origin.lat + y / this.ky, lng: this.origin.lng + x / this.kx };
  }
}

export interface Sample {
  lng: number;
  lat: number;
  /** 累積距離（m） */
  d: number;
  ele: number;
}

/** 依固定間距重新取樣 polyline（座標為 [lng, lat, ele]） */
export function resample(coords: [number, number, number][], step: number): Sample[] {
  if (coords.length === 0) return [];
  const out: Sample[] = [{ lng: coords[0][0], lat: coords[0][1], d: 0, ele: coords[0][2] }];
  let acc = 0;
  let next = step;
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0, e0] = coords[i - 1];
    const [x1, y1, e1] = coords[i];
    const seg = haversine(y0, x0, y1, x1);
    if (seg === 0) continue;
    while (acc + seg >= next) {
      const t = (next - acc) / seg;
      out.push({ lng: x0 + (x1 - x0) * t, lat: y0 + (y1 - y0) * t, d: next, ele: e0 + (e1 - e0) * t });
      next += step;
    }
    acc += seg;
  }
  const last = coords[coords.length - 1];
  if (acc > out[out.length - 1].d + 1e-6) out.push({ lng: last[0], lat: last[1], d: acc, ele: last[2] });
  return out;
}

export function polylineLength(coords: [number, number, number][] | [number, number][]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return len;
}

/** 以網格做「點是否在某 polyline 附近」的快速查詢 */
export class PointGrid {
  private readonly cells = new Map<string, { x: number; y: number; tag: number }[]>();
  private readonly proj: LocalProjection;
  constructor(private readonly cellSize: number, origin: LatLng) {
    this.proj = new LocalProjection(origin);
  }
  private key(cx: number, cy: number) {
    return `${cx},${cy}`;
  }
  add(lat: number, lng: number, tag = 0) {
    const [x, y] = this.proj.toXY({ lat, lng });
    const k = this.key(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
    let arr = this.cells.get(k);
    if (!arr) this.cells.set(k, (arr = []));
    arr.push({ x, y, tag });
  }
  /** 回傳 radius 內是否有點，可用 accept 篩選 tag */
  hasNear(lat: number, lng: number, radius: number, accept?: (tag: number) => boolean): boolean {
    const [x, y] = this.proj.toXY({ lat, lng });
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const r = Math.ceil(radius / this.cellSize);
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cy - r; j <= cy + r; j++) {
        const arr = this.cells.get(this.key(i, j));
        if (!arr) continue;
        for (const p of arr) {
          if ((p.x - x) ** 2 + (p.y - y) ** 2 <= radius * radius && (!accept || accept(p.tag))) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

export { toRad, toDeg };
