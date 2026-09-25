// 前後端共用型別（只使用 type import，不會產生執行期相依）

export interface LatLng {
  lat: number;
  lng: number;
  label?: string;
}

/** 1 = 偏好, 0 = 不限, -1 = 避開 */
export type Preference = 1 | 0 | -1;

export interface RoutePreferences {
  avoidSignals: boolean;
  sidewalk: Preference;
  cycleway: Preference;
  road: Preference;
}

export type DistanceOption = { mode: 'shortest' } | { mode: 'target'; km: number };

export interface GenerateRequest {
  start: LatLng;
  end: LatLng | null;
  loop: boolean;
  waypoints: LatLng[];
  prefs: RoutePreferences;
  distance: DistanceOption;
  /** 自訂總爬升（m）；不指定 = 不限。規劃時盡量接近即可 */
  climb?: { targetM: number };
  /** 產生幾條新路線（預設 3） */
  count?: number;
  /** 不指定則每次隨機 */
  seed?: number;
  /** 已鎖定的路線幾何（[lng, lat][]），新路線會盡量與之不同 */
  exclude?: [number, number][][];
}

export type WayCategory = 'sidewalk' | 'cycleway' | 'road';

export interface WayRun {
  category: WayCategory;
  from: number;
  to: number;
}

export interface ElevationPoint {
  /** 累積距離（m） */
  d: number;
  /** 高度（m） */
  e: number;
}

export interface RouteResult {
  id: string;
  /** [lng, lat, ele] */
  coordinates: [number, number, number][];
  distanceM: number;
  ascentM: number;
  descentM: number;
  minEleM: number;
  maxEleM: number;
  elevationProfile: ElevationPoint[];
  /** 經過的紅綠燈路口（已合併同一路口的多個號誌），[lng, lat] */
  signals: [number, number][];
  /** 各路型的距離（m） */
  breakdown: Record<WayCategory, number>;
  /** 路型分段：coordinates[from..to]（含兩端）屬於 category，相鄰同類已合併 */
  wayRuns: WayRun[];
  /** 路線自我重疊（折返）比例 0~1 */
  selfOverlap: number;
  /** 與目標距離的誤差比例（僅指定距離模式） */
  lengthError?: number;
  kind: 'shortest' | 'alternative' | 'random';
}

export interface GenerateResponse {
  seed: number;
  /** 本次請求的目標總爬升（m） */
  climbTargetM?: number;
  routes: RouteResult[];
  warnings: string[];
  stats: { candidates: number; routerCalls: number; ms: number };
}

export interface GeocodeResult {
  name: string;
  lat: number;
  lng: number;
}
