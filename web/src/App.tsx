import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenerateRequest, LatLng, RouteResult } from '../../shared/types';
import { generateRoutes, importTrack } from './api';
import ElevationChart from './components/ElevationChart';
import MapView from './components/MapView';
import OptionsPanel, { type Options } from './components/OptionsPanel';
import PointsPanel, { type PickMode } from './components/PointsPanel';
import RouteCards from './components/RouteCards';
import {
  CATEGORY_COLOR,
  fmtKm,
  IMPORTED_COLOR,
  type LayerToggles,
  loadSetting,
  parseGpx,
  parsePace,
  pointAtDistance,
  ROUTE_COLORS,
  ROUTE_NAMES,
  saveSetting,
  SIGNAL_COLOR,
  STORE_COLOR,
  thinCoords,
} from './lib';

function distMeters(a: number[], b: number[]) {
  const r = Math.PI / 180;
  const x = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r);
  const y = (b[1] - a[1]) * r;
  return Math.hypot(x, y) * 6371008.8;
}

const DEFAULT_OPTIONS: Options = {
  loop: true,
  distanceMode: 'target',
  km: 10,
  climbMode: 'any',
  climbM: 100,
  effort: 3,
  count: 3,
  prefs: { avoidSignals: true, sidewalk: 0, cycleway: 0, road: 0, trail: 0 },
  pace: '6:00',
};

export default function App() {
  const [start, setStart] = useState<LatLng | null>(() => loadSetting('start', null));
  const [end, setEnd] = useState<LatLng | null>(null);
  const [waypoints, setWaypoints] = useState<LatLng[]>([]);
  const [options, setOptions] = useState<Options>(() => {
    const saved = loadSetting<Partial<Options>>('options', {});
    // 偏好也要逐項合併：舊版存下的設定沒有後來新增的路型（例如小徑）
    return { ...DEFAULT_OPTIONS, ...saved, prefs: { ...DEFAULT_OPTIONS.prefs, ...saved.prefs } };
  });
  const [pickMode, setPickMode] = useState<PickMode>('start');
  const [layers, setLayers] = useState<LayerToggles>(() => ({
    signals: true,
    sidewalk: false,
    cycleway: false,
    trail: false,
    stores: true,
    ...loadSetting<Partial<LayerToggles>>('layers', {}),
  }));

  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverDist, setHoverDist] = useState<number | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [focus, setFocus] = useState<{ p: LatLng; key: number } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  // 各路線產生時的目標爬升（鎖定的路線保留當時的目標）
  const [climbTargets, setClimbTargets] = useState<Record<string, number>>({});

  useEffect(() => saveSetting('options', options), [options]);
  useEffect(() => saveSetting('start', start), [start]);
  useEffect(() => saveSetting('layers', layers), [layers]);

  // 切換環狀時，點選模式不能停在「終點」
  useEffect(() => {
    if (options.loop && pickMode === 'end') setPickMode('waypoint');
  }, [options.loop, pickMode]);

  // 匯入的路線用深灰色、名稱 GPX1、GPX2…；規劃的路線依序 A、B、C
  const [colors, names] = useMemo(() => {
    const c: Record<string, string> = {};
    const n: Record<string, string> = {};
    let gi = 0;
    let ii = 0;
    for (const r of routes) {
      if (r.kind === 'imported') {
        c[r.id] = IMPORTED_COLOR;
        n[r.id] = `GPX${++ii}`;
      } else {
        c[r.id] = ROUTE_COLORS[gi % ROUTE_COLORS.length];
        n[r.id] = ROUTE_NAMES[gi % ROUTE_NAMES.length];
        gi++;
      }
    }
    return [c, n];
  }, [routes]);
  const selected = routes.find((r) => r.id === selectedId) ?? null;
  const hoverPoint = useMemo(
    () => (selected && hoverDist !== null ? pointAtDistance(selected.coordinates, hoverDist) : null),
    [selected, hoverDist],
  );

  const requestKey = JSON.stringify([
    start,
    end,
    waypoints,
    options.loop,
    options.distanceMode,
    options.km,
    options.climbMode,
    options.climbM,
    options.prefs,
  ]);
  const stale = routes.length > 0 && lastKey !== null && lastKey !== requestKey;

  const handleMapClick = (p: LatLng) => {
    if (pickMode === 'start') {
      setStart(p);
      setPickMode(options.loop || end ? 'waypoint' : 'end');
    } else if (pickMode === 'end') {
      setEnd(p);
      setPickMode('waypoint');
    } else {
      setWaypoints((w) => [...w, p]);
    }
  };

  const handleMovePoint = (kind: 'start' | 'end' | 'waypoint', index: number, p: LatLng) => {
    if (kind === 'start') setStart(p);
    else if (kind === 'end') setEnd(p);
    else setWaypoints((w) => w.map((x, i) => (i === index ? p : x)));
  };

  // 匯入的路線不佔路線數量名額，重新產生時一律保留
  const importedRoutes = routes.filter((r) => r.kind === 'imported');
  const lockedRoutes = routes.filter((r) => locked.has(r.id) && r.kind !== 'imported');
  const newCount = options.count - lockedRoutes.length;

  const canGenerate =
    !!start &&
    (options.loop || !!end) &&
    newCount > 0 &&
    !(options.distanceMode === 'target' && !(options.km >= 0.5 && options.km <= 100)) &&
    !(options.climbMode === 'target' && !(options.climbM >= 0 && options.climbM <= 5000));

  const generate = async () => {
    if (!start || !canGenerate) return;
    setLoading(true);
    setError(null);
    setWarnings([]);
    const req: GenerateRequest = {
      start,
      end: options.loop ? null : end,
      loop: options.loop,
      waypoints,
      prefs: options.prefs,
      distance:
        options.distanceMode === 'target' ? { mode: 'target', km: options.km } : { mode: 'shortest' },
      climb: options.climbMode === 'target' ? { targetM: options.climbM } : undefined,
      count: newCount,
      effort: options.effort,
      exclude: lockedRoutes.map((r) => thinCoords(r.coordinates)),
    };
    try {
      const res = await generateRoutes(req);
      // 避免與鎖定路線的 id 衝突
      const fresh = res.routes.filter((r) => !locked.has(r.id));
      const next = [...importedRoutes, ...lockedRoutes, ...fresh];
      setRoutes(next);
      setClimbTargets((prev) => {
        const t: Record<string, number> = {};
        for (const r of lockedRoutes) if (prev[r.id] !== undefined) t[r.id] = prev[r.id];
        if (res.climbTargetM !== undefined) for (const r of fresh) t[r.id] = res.climbTargetM;
        return t;
      });
      setSelectedId(fresh[0]?.id ?? next[0]?.id ?? null);
      setWarnings(res.warnings);
      setInfo(`種子 ${res.seed} · ${res.stats.candidates} 個候選 · ${res.stats.routerCalls} 次路徑運算 · ${(res.stats.ms / 1000).toFixed(1)} 秒`);
      setFitKey((k) => k + 1);
      setLastKey(requestKey);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const toggleLock = (id: string) =>
    setLocked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const handleImport = async (file: File) => {
    setImporting(true);
    setError(null);
    setWarnings([]);
    try {
      const { name, points, source, timed } = parseGpx(await file.text(), file.name);
      const res = await importTrack({ name, points, source, timed });
      setRoutes((rs) => [res.route, ...rs]);
      setSelectedId(res.route.id);
      setWarnings(res.warnings);
      setInfo(
        source === 'track'
          ? `已匯入「${name}」：貼齊道路後 ${(res.route.distanceM / 1000).toFixed(2)} km`
          : `已匯入「${name}」：${points.length} 個路線點，依道路連接後 ${(res.route.distanceM / 1000).toFixed(2)} km`,
      );
      setFitKey((k) => k + 1);
    } catch (e) {
      setError(`匯入失敗：${(e as Error).message}`);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeRoute = (id: string) => {
    setRoutes((rs) => rs.filter((r) => r.id !== id));
    if (selectedId === id) setSelectedId(routes.find((r) => r.id !== id)?.id ?? null);
  };

  /** 以匯入路線的起終點與距離作為規劃條件 */
  const useAsConditions = (r: RouteResult) => {
    const [first, last] = [r.coordinates[0], r.coordinates[r.coordinates.length - 1]];
    const s: LatLng = { lng: first[0], lat: first[1], label: `${r.name ?? 'GPX'} 起點` };
    const isLoop = distMeters(first, last) < 200;
    setStart(s);
    setEnd(isLoop ? null : { lng: last[0], lat: last[1], label: `${r.name ?? 'GPX'} 終點` });
    setWaypoints([]);
    setOptions((o) => ({
      ...o,
      loop: isLoop,
      distanceMode: 'target',
      km: Math.round(r.distanceM / 100) / 10,
    }));
    setPickMode('waypoint');
  };

  const clearAll = () => {
    setStart(null);
    setEnd(null);
    setWaypoints([]);
    setRoutes([]);
    setLocked(new Set());
    setSelectedId(null);
    setPickMode('start');
    setWarnings([]);
    setError(null);
    setInfo(null);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="app-header">
          <h1>🏃 路跑路線規劃</h1>
          <button className="link" onClick={clearAll}>
            全部清除
          </button>
        </header>

        <PointsPanel
          start={start}
          end={end}
          loop={options.loop}
          waypoints={waypoints}
          pickMode={pickMode}
          setPickMode={setPickMode}
          setStart={setStart}
          setEnd={setEnd}
          setWaypoints={setWaypoints}
          onFocus={(p) => setFocus({ p, key: Date.now() })}
        />

        <OptionsPanel options={options} onChange={setOptions} />

        <section className="panel-section">
          <button className="primary" disabled={!canGenerate || loading} onClick={generate}>
            {loading
              ? '規劃中…'
              : routes.length
                ? `重新產生${lockedRoutes.length ? `（保留 ${lockedRoutes.length} 條鎖定）` : ''}`
                : '產生路線'}
          </button>
          <button className="secondary" disabled={importing} onClick={() => fileRef.current?.click()}>
            {importing ? '比對 GPX 中…' : '📂 匯入 GPX 分析'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".gpx,application/gpx+xml"
            hidden
            onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])}
          />
          {!start && <div className="hint">先在地圖上點選起點，或用搜尋／目前位置。</div>}
          {start && !options.loop && !end && <div className="hint">請設定終點，或勾選「環狀路線」。</div>}
          {newCount <= 0 && (
            <div className="hint">鎖定的路線已達路線數量（{options.count} 條），請增加數量或解除鎖定。</div>
          )}
          {stale && !loading && <div className="hint warn-text">條件已變更，按下「重新產生」套用。</div>}
          {error && <div className="alert error">{error}</div>}
          {warnings.map((w) => (
            <div key={w} className="alert warn">
              {w}
            </div>
          ))}
        </section>

        {routes.length > 0 && (
          <section className="panel-section">
            <h2>路線結果</h2>
            <RouteCards
              routes={routes}
              colors={colors}
              names={names}
              selectedId={selectedId}
              locked={locked}
              climbTargets={climbTargets}
              paceSec={parsePace(options.pace)}
              onSelect={setSelectedId}
              onToggleLock={toggleLock}
              onRemove={removeRoute}
              onUseAsConditions={useAsConditions}
            />
            {info && <div className="hint mono">{info}</div>}
          </section>
        )}
      </aside>

      <main className="map-wrap">
        <MapView
          start={start}
          end={end}
          loop={options.loop}
          waypoints={waypoints}
          routes={routes}
          colors={colors}
          selectedId={selectedId}
          hoverPoint={hoverPoint}
          layers={layers}
          fitKey={fitKey}
          focus={focus}
          onMapClick={handleMapClick}
          onMovePoint={handleMovePoint}
          onSelectRoute={setSelectedId}
        />
        <div className="pick-badge">
          點地圖設定：{pickMode === 'start' ? (options.loop ? '起終點' : '起點') : pickMode === 'end' ? '終點' : '經過點'}
        </div>
        {selected && (
          <div className="layer-panel">
            <div className="layer-title">路線 {names[selected.id]} 上顯示</div>
            {(
              [
                { key: 'signals', label: '紅綠燈', color: SIGNAL_COLOR, dot: true, value: `${selected.signals.length} 處` },
                { key: 'sidewalk', label: '人行道／步道', color: CATEGORY_COLOR.sidewalk, dot: false, value: `${fmtKm(selected.breakdown.sidewalk)} km` },
                { key: 'cycleway', label: '腳踏車道', color: CATEGORY_COLOR.cycleway, dot: false, value: `${fmtKm(selected.breakdown.cycleway)} km` },
                { key: 'trail', label: '小徑／土路', color: CATEGORY_COLOR.trail, dot: false, value: `${fmtKm(selected.breakdown.trail ?? 0)} km` },
                { key: 'stores', label: '便利商店', color: STORE_COLOR.seven, dot: true, value: `${selected.stores.length} 間` },
              ] as const
            ).map((l) => (
              <label key={l.key} className="layer-row">
                <input
                  type="checkbox"
                  checked={layers[l.key]}
                  onChange={(e) => setLayers((x) => ({ ...x, [l.key]: e.target.checked }))}
                />
                <i className={l.dot ? 'legend-dot' : 'legend-line'} style={{ background: l.color }} />
                <span>{l.label}</span>
                <span className="layer-value">{l.value}</span>
              </label>
            ))}
          </div>
        )}
        {selected && (
          <div className="elev-panel">
            <div className="elev-title">
              <span className="swatch" style={{ background: colors[selected.id] }} />
              路線 {names[selected.id]} 高度剖面（m / km）
              <span className="elev-sub">
                ↗ {Math.round(selected.ascentM)} m　↘ {Math.round(selected.descentM)} m
              </span>
            </div>
            <ElevationChart
              profile={selected.elevationProfile}
              color={colors[selected.id]}
              hoverDist={hoverDist}
              onHover={setHoverDist}
              markers={
                layers.stores
                  ? selected.stores.map((s) => ({ d: s.alongM, color: STORE_COLOR[s.brand], label: s.name }))
                  : []
              }
            />
          </div>
        )}
        {loading && <div className="map-loading">規劃路線中…</div>}
      </main>
    </div>
  );
}
