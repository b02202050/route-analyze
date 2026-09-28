import type { Preference, RoutePreferences } from '../../../shared/types';

export interface Options {
  loop: boolean;
  distanceMode: 'shortest' | 'target';
  km: number;
  climbMode: 'any' | 'target';
  climbM: number;
  /** 努力程度 1～5 */
  effort: number;
  prefs: RoutePreferences;
  pace: string;
}

interface Props {
  options: Options;
  onChange: (o: Options) => void;
}

const PREF_ROWS: { key: 'sidewalk' | 'cycleway' | 'road'; label: string }[] = [
  { key: 'sidewalk', label: '人行道／步道' },
  { key: 'cycleway', label: '腳踏車道' },
  { key: 'road', label: '一般馬路' },
];

const EFFORT_LABELS = ['', '最快', '較快', '平衡', '較仔細', '最仔細'];

const PREF_CHOICES: { v: Preference; label: string }[] = [
  { v: 1, label: '偏好' },
  { v: 0, label: '不限' },
  { v: -1, label: '避開' },
];

export default function OptionsPanel({ options: o, onChange }: Props) {
  const set = (patch: Partial<Options>) => onChange({ ...o, ...patch });
  const setPref = (patch: Partial<RoutePreferences>) => set({ prefs: { ...o.prefs, ...patch } });

  return (
    <section className="panel-section">
      <h2>路線條件</h2>

      <label className="check">
        <input type="checkbox" checked={o.loop} onChange={(e) => set({ loop: e.target.checked })} />
        環狀路線（跑回起點）
      </label>

      <div className="field">
        <div className="field-label">路線長度</div>
        <label className="radio">
          <input
            type="radio"
            name="dist"
            checked={o.distanceMode === 'target'}
            onChange={() => set({ distanceMode: 'target' })}
          />
          指定距離
          <input
            type="number"
            className="km-input"
            min={0.5}
            max={100}
            step={0.5}
            value={o.km}
            onFocus={() => set({ distanceMode: 'target' })}
            onChange={(e) => set({ km: Number(e.target.value) })}
          />
          km
        </label>
        <label className="radio">
          <input
            type="radio"
            name="dist"
            checked={o.distanceMode === 'shortest'}
            onChange={() => set({ distanceMode: 'shortest' })}
          />
          最短路徑
        </label>
      </div>

      <div className="field">
        <div className="field-label">總爬升</div>
        <label className="radio">
          <input
            type="radio"
            name="climb"
            checked={o.climbMode === 'any'}
            onChange={() => set({ climbMode: 'any' })}
          />
          不限
        </label>
        <label className="radio">
          <input
            type="radio"
            name="climb"
            checked={o.climbMode === 'target'}
            onChange={() => set({ climbMode: 'target' })}
          />
          自訂約
          <input
            type="number"
            className="km-input"
            min={0}
            max={5000}
            step={10}
            value={o.climbM}
            onFocus={() => set({ climbMode: 'target' })}
            onChange={(e) => set({ climbM: Number(e.target.value) })}
          />
          m
        </label>
        {o.climbMode === 'target' && (
          <div className="hint">會盡量接近，不保證剛好；受當地地形限制時會提示。</div>
        )}
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={o.prefs.avoidSignals}
          onChange={(e) => setPref({ avoidSignals: e.target.checked })}
        />
        盡量避開紅綠燈
      </label>

      <div className="field">
        <div className="field-label">路型偏好</div>
        {PREF_ROWS.map((row) => (
          <div className="pref-row" key={row.key}>
            <span>{row.label}</span>
            <div className="segmented small">
              {PREF_CHOICES.map((c) => (
                <button
                  key={c.v}
                  className={o.prefs[row.key] === c.v ? `active pref-${c.v}` : ''}
                  onClick={() => setPref({ [row.key]: c.v })}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="field">
        <div className="field-label">
          努力程度：{EFFORT_LABELS[o.effort]}
        </div>
        <div className="effort-row">
          <span>快速</span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={o.effort}
            onChange={(e) => set({ effort: Number(e.target.value) })}
          />
          <span>精準</span>
        </div>
        <div className="hint">越往右嘗試越多候選路線，較能符合距離、爬升與偏好，但需要較久時間。</div>
      </div>

      <label className="field inline">
        <span className="field-label">配速</span>
        <input
          className="pace-input"
          value={o.pace}
          onChange={(e) => set({ pace: e.target.value })}
          placeholder="6:00"
        />
        <span>/km（估算完成時間用）</span>
      </label>
    </section>
  );
}
