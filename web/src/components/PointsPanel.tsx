import { useState } from 'react';
import type { GeocodeResult, LatLng } from '../../../shared/types';
import { geocode } from '../api';
import { pointLabel } from '../lib';

export type PickMode = 'start' | 'end' | 'waypoint';

interface Props {
  start: LatLng | null;
  end: LatLng | null;
  loop: boolean;
  waypoints: LatLng[];
  pickMode: PickMode;
  setPickMode: (m: PickMode) => void;
  setStart: (p: LatLng | null) => void;
  setEnd: (p: LatLng | null) => void;
  setWaypoints: (w: LatLng[]) => void;
  onFocus: (p: LatLng) => void;
}

export default function PointsPanel(p: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const search = async () => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const r = await geocode(q);
      setResults(r);
      if (r.length === 0) setSearchError('找不到符合的地點');
    } catch (e) {
      setSearchError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const use = (r: GeocodeResult, kind: PickMode) => {
    const pt: LatLng = { lat: r.lat, lng: r.lng, label: r.name.split('（')[0] };
    if (kind === 'start') p.setStart(pt);
    else if (kind === 'end') p.setEnd(pt);
    else p.setWaypoints([...p.waypoints, pt]);
    p.onFocus(pt);
    setResults([]);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return setSearchError('瀏覽器不支援定位');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: '目前位置' };
        p.setStart(pt);
        p.onFocus(pt);
      },
      (err) => setSearchError(`無法取得位置：${err.message}`),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const moveWaypoint = (i: number, dir: -1 | 1) => {
    const w = [...p.waypoints];
    const j = i + dir;
    if (j < 0 || j >= w.length) return;
    [w[i], w[j]] = [w[j], w[i]];
    p.setWaypoints(w);
  };

  const modes: { key: PickMode; label: string }[] = [
    { key: 'start', label: p.loop ? '起終點' : '起點' },
    ...(p.loop ? [] : [{ key: 'end' as const, label: '終點' }]),
    { key: 'waypoint', label: '經過點' },
  ];

  return (
    <section className="panel-section">
      <h2>地點</h2>

      <div className="search-row">
        <input
          type="search"
          placeholder="搜尋地點（例：桃園高鐵站）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button onClick={search} disabled={searching}>
          {searching ? '…' : '搜尋'}
        </button>
      </div>
      {searchError && <div className="hint error-text">{searchError}</div>}
      {results.length > 0 && (
        <ul className="search-results">
          {results.map((r, i) => (
            <li key={i}>
              <span className="result-name" title={r.name}>
                {r.name}
              </span>
              <span className="result-actions">
                <button onClick={() => use(r, 'start')}>起點</button>
                {!p.loop && <button onClick={() => use(r, 'end')}>終點</button>}
                <button onClick={() => use(r, 'waypoint')}>經過</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="pick-mode">
        <span>點地圖設定：</span>
        <div className="segmented">
          {modes.map((m) => (
            <button
              key={m.key}
              className={p.pickMode === m.key ? 'active' : ''}
              onClick={() => p.setPickMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="point-list">
        <li>
          <span className="dot dot-start">{p.loop ? '起終' : '起'}</span>
          <span className="point-name" onClick={() => p.start && p.onFocus(p.start)}>
            {p.start ? pointLabel(p.start) : <em>尚未設定</em>}
          </span>
          <button className="icon" title="使用目前位置" onClick={useMyLocation}>
            ◎
          </button>
          {p.start && (
            <button className="icon" title="清除" onClick={() => p.setStart(null)}>
              ✕
            </button>
          )}
        </li>
        {p.waypoints.map((w, i) => (
          <li key={i}>
            <span className="dot dot-way">{i + 1}</span>
            <span className="point-name" onClick={() => p.onFocus(w)}>
              {pointLabel(w)}
            </span>
            <button className="icon" title="上移" disabled={i === 0} onClick={() => moveWaypoint(i, -1)}>
              ↑
            </button>
            <button
              className="icon"
              title="下移"
              disabled={i === p.waypoints.length - 1}
              onClick={() => moveWaypoint(i, 1)}
            >
              ↓
            </button>
            <button
              className="icon"
              title="刪除"
              onClick={() => p.setWaypoints(p.waypoints.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </li>
        ))}
        {!p.loop && (
          <li>
            <span className="dot dot-end">終</span>
            <span className="point-name" onClick={() => p.end && p.onFocus(p.end)}>
              {p.end ? pointLabel(p.end) : <em>尚未設定</em>}
            </span>
            {p.start && p.end && (
              <button
                className="icon"
                title="交換起終點"
                onClick={() => {
                  p.setStart(p.end);
                  p.setEnd(p.start);
                }}
              >
                ⇅
              </button>
            )}
            {p.end && (
              <button className="icon" title="清除" onClick={() => p.setEnd(null)}>
                ✕
              </button>
            )}
          </li>
        )}
      </ul>
      <div className="hint">地圖上的標記可以直接拖曳調整位置。</div>
    </section>
  );
}
