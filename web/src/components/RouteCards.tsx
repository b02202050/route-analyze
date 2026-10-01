import { useEffect, useState } from 'react';
import type { RouteResult, WayCategory } from '../../../shared/types';
import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  downloadGpx,
  fmtDuration,
  fmtKm,
  KIND_LABEL,
  loadSetting,
  saveSetting,
} from '../lib';

interface Props {
  routes: RouteResult[];
  colors: Record<string, string>;
  names: Record<string, string>;
  selectedId: string | null;
  locked: Set<string>;
  climbTargets: Record<string, number>;
  paceSec: number | null;
  onSelect: (id: string) => void;
  onToggleLock: (id: string) => void;
  onRemove: (id: string) => void;
  onUseAsConditions: (r: RouteResult) => void;
}

const CATS: WayCategory[] = ['sidewalk', 'cycleway', 'trail', 'road'];

/** 沿路最長一段沒有便利商店的距離（m），含起點到第一間、最後一間到終點 */
function longestGap(r: RouteResult): number {
  const marks = [0, ...r.stores.map((s) => s.alongM), r.distanceM];
  let gap = 0;
  for (let i = 1; i < marks.length; i++) gap = Math.max(gap, marks[i] - marks[i - 1]);
  return gap;
}

/** 人行道／步道 + 腳踏車道 佔全程的比例 */
function footShare(r: RouteResult): number {
  const total = CATS.reduce((s, c) => s + (r.breakdown[c] ?? 0), 0) || 1;
  return ((r.breakdown.sidewalk ?? 0) + (r.breakdown.cycleway ?? 0)) / total;
}

type SortKey = 'default' | 'distance' | 'ascent' | 'signals' | 'footShare';

/** asc = 預設由小到大 */
const SORTS: Record<SortKey, { label: string; value: (r: RouteResult) => number; asc: boolean }> = {
  default: { label: '產生順序', value: () => 0, asc: true },
  distance: { label: '距離', value: (r) => r.distanceM, asc: true },
  ascent: { label: '總爬升', value: (r) => r.ascentM, asc: true },
  signals: { label: '紅綠燈', value: (r) => r.signals.length, asc: true },
  footShare: { label: '人行道＋腳踏車道佔比', value: footShare, asc: false },
};

const fmtDiff = (d: number) => (d > 0 ? `+${d}` : d < 0 ? `${d}` : '±0');

export default function RouteCards(p: Props) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>(() => {
    const s = loadSetting<{ key?: string; asc?: boolean }>('sort', {});
    return s.key && s.key in SORTS
      ? { key: s.key as SortKey, asc: s.asc ?? SORTS[s.key as SortKey].asc }
      : { key: 'default', asc: true };
  });
  useEffect(() => saveSetting('sort', sort), [sort]);

  const spec = SORTS[sort.key];
  // 只改變卡片顯示順序；路線名稱（A、B…）與顏色維持不變
  const ordered =
    sort.key === 'default'
      ? p.routes
      : [...p.routes].sort((a, b) => (spec.value(a) - spec.value(b)) * (sort.asc ? 1 : -1));

  return (
    <div className="route-cards">
      {p.routes.length > 1 && (
        <div className="sort-bar">
          <span>排序</span>
          <select
            value={sort.key}
            onChange={(e) => {
              const key = e.target.value as SortKey;
              setSort({ key, asc: SORTS[key].asc });
            }}
          >
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORTS[k].label}
              </option>
            ))}
          </select>
          {sort.key !== 'default' && (
            <button
              className="sort-dir"
              title="切換由小到大／由大到小"
              onClick={() => setSort((s) => ({ ...s, asc: !s.asc }))}
            >
              {sort.asc ? '由小到大 ↑' : '由大到小 ↓'}
            </button>
          )}
        </div>
      )}
      {ordered.map((r) => {
        const total = CATS.reduce((s, c) => s + (r.breakdown[c] ?? 0), 0) || 1;
        const selected = r.id === p.selectedId;
        const isLocked = p.locked.has(r.id);
        const km = r.distanceM / 1000;
        return (
          <div
            key={r.id}
            className={`route-card ${selected ? 'selected' : ''}`}
            style={{ borderColor: selected ? p.colors[r.id] : undefined }}
            onClick={() => p.onSelect(r.id)}
          >
            <div className="card-head">
              <span className="swatch" style={{ background: p.colors[r.id] }} />
              <strong>路線 {p.names[r.id]}</strong>
              <span className="kind" title={r.name}>
                {r.kind === 'imported' ? r.name ?? KIND_LABEL.imported : KIND_LABEL[r.kind]}
              </span>
              <span className="spacer" />
              {r.kind === 'imported' ? (
                <button
                  className="icon"
                  title="移除這條匯入的路線"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onRemove(r.id);
                  }}
                >
                  ✕
                </button>
              ) : (
              <button
                className={`icon ${isLocked ? 'locked' : ''}`}
                title={isLocked ? '取消鎖定' : '鎖定（重新產生時保留）'}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onToggleLock(r.id);
                }}
              >
                {isLocked ? '🔒' : '🔓'}
              </button>
              )}
              <button
                className="icon"
                title="下載 GPX"
                onClick={(e) => {
                  e.stopPropagation();
                  downloadGpx(r, `路跑路線${p.names[r.id]}-${km.toFixed(1)}km`);
                }}
              >
                GPX
              </button>
            </div>

            <div className="stats">
              <div>
                <span className="stat-value">{fmtKm(r.distanceM)}</span>
                <span className="stat-label">距離 km</span>
              </div>
              <div>
                <span className="stat-value">↗ {Math.round(r.ascentM)}</span>
                <span className="stat-label">總爬升 m</span>
              </div>
              <div>
                <span className="stat-value">↘ {Math.round(r.descentM)}</span>
                <span className="stat-label">總下降 m</span>
              </div>
              <div>
                <span className="stat-value">🚦 {r.signals.length}</span>
                <span className="stat-label">紅綠燈</span>
              </div>
            </div>

            <div className="meta">
              {p.paceSec && <span>預估 {fmtDuration(km * p.paceSec)}</span>}
              <span>
                高度 {Math.round(r.minEleM)}–{Math.round(r.maxEleM)} m
              </span>
              {r.lengthError !== undefined && (
                <span>
                  誤差 {r.lengthError >= 0 ? '+' : ''}
                  {(r.lengthError * 100).toFixed(1)}%
                </span>
              )}
              {p.climbTargets[r.id] !== undefined && (
                <span>
                  目標爬升 {p.climbTargets[r.id]} m（{fmtDiff(Math.round(r.ascentM - p.climbTargets[r.id]))}）
                </span>
              )}
              <span>
                便利商店 {r.stores.length} 間
                {r.stores.length > 0 && `（最長 ${fmtKm(longestGap(r))} km 無補給）`}
              </span>
              {r.selfOverlap > 0.15 && <span>重複路段 {Math.round(r.selfOverlap * 100)}%</span>}
            </div>

            <div className="breakdown" title="路型比例">
              {CATS.map((c) =>
                r.breakdown[c] > 0 ? (
                  <span
                    key={c}
                    style={{ width: `${(r.breakdown[c] / total) * 100}%`, background: CATEGORY_COLOR[c] }}
                  />
                ) : null,
              )}
            </div>
            <div className="breakdown-legend">
              {/* 小徑在市區路線通常是 0，沒有時不顯示以免擁擠 */}
              {CATS.filter((c) => c !== 'trail' || (r.breakdown.trail ?? 0) > 0).map((c) => (
                <span key={c}>
                  <i style={{ background: CATEGORY_COLOR[c] }} />
                  {CATEGORY_LABEL[c]} {Math.round((r.breakdown[c] / total) * 100)}%
                </span>
              ))}
            </div>
            {r.kind === 'imported' && (
              <div className="card-actions">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onUseAsConditions(r);
                  }}
                  title="把起點、終點（或環狀）與距離設為規劃條件"
                >
                  使用此路線的起終點與距離規劃
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
