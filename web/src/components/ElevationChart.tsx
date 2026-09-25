import { useEffect, useMemo, useRef, useState } from 'react';
import type { ElevationPoint } from '../../../shared/types';

interface Props {
  profile: ElevationPoint[];
  color: string;
  hoverDist: number | null;
  onHover: (d: number | null) => void;
  /** 沿路標記（例如便利商店），d = 沿路距離 m */
  markers?: { d: number; color: string; label: string }[];
}

const PAD = { l: 38, r: 16, t: 10, b: 22 };

function niceStep(range: number, target: number) {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * pow;
}

export default function ElevationChart({ profile, color, hoverDist, onHover, markers = [] }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [[W, H], setSize] = useState<[number, number]>([600, 130]);

  // 以實際像素寬度繪製，避免文字被拉伸
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setSize([Math.max(200, entry.contentRect.width), Math.max(60, entry.contentRect.height)]),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => {
    if (profile.length < 2) return null;
    const maxD = profile[profile.length - 1].d;
    let minE = Math.min(...profile.map((p) => p.e));
    let maxE = Math.max(...profile.map((p) => p.e));
    // 最小顯示 20 m 範圍，避免平路被放大成山
    if (maxE - minE < 20) {
      const mid = (maxE + minE) / 2;
      minE = mid - 10;
      maxE = mid + 10;
    }
    const eStep = niceStep(maxE - minE, H < 100 ? 2 : 3);
    minE = Math.floor(minE / eStep) * eStep;
    maxE = Math.ceil(maxE / eStep) * eStep;
    const x = (d: number) => PAD.l + (d / maxD) * (W - PAD.l - PAD.r);
    const y = (e: number) => PAD.t + (1 - (e - minE) / (maxE - minE)) * (H - PAD.t - PAD.b);
    const line = profile.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.e).toFixed(1)}`).join('');
    const area = `${line}L${x(maxD)},${H - PAD.b}L${x(0)},${H - PAD.b}Z`;
    const eTicks: number[] = [];
    for (let e = minE; e <= maxE + 1e-6; e += eStep) eTicks.push(e);
    const dStep = niceStep(maxD / 1000, 5) * 1000;
    const dTicks: number[] = [];
    for (let d = 0; d <= maxD; d += dStep) dTicks.push(d);
    return { maxD, x, y, line, area, eTicks, dTicks };
  }, [profile, W, H]);

  if (!g) return <svg ref={svgRef} className="elev-chart" />;

  const hover = (() => {
    if (hoverDist === null) return null;
    let i = profile.findIndex((p) => p.d >= hoverDist);
    if (i < 0) i = profile.length - 1;
    return profile[i];
  })();

  const handleMove = (ev: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const d = ((px - PAD.l) / (W - PAD.l - PAD.r)) * g.maxD;
    onHover(d < 0 || d > g.maxD ? null : d);
  };

  return (
    <svg
      ref={svgRef}
      className="elev-chart"
      viewBox={`0 0 ${W} ${H}`}
      onPointerMove={handleMove}
      onPointerLeave={() => onHover(null)}
    >
      {g.eTicks.map((e) => (
        <g key={e}>
          <line x1={PAD.l} x2={W - PAD.r} y1={g.y(e)} y2={g.y(e)} className="grid" />
          <text x={PAD.l - 4} y={g.y(e) + 3} textAnchor="end" className="tick">
            {e}
          </text>
        </g>
      ))}
      {g.dTicks.map((d) => (
        <text key={d} x={g.x(d)} y={H - 6} textAnchor="middle" className="tick">
          {(d / 1000).toFixed(d % 1000 ? 1 : 0)}
        </text>
      ))}
      <path d={g.area} fill={color} opacity={0.18} />
      <path d={g.line} fill="none" stroke={color} strokeWidth={2} />
      {markers.map((m, i) => (
        <g key={i}>
          <line x1={g.x(m.d)} x2={g.x(m.d)} y1={PAD.t} y2={H - PAD.b} stroke={m.color} strokeWidth={1} opacity={0.35} />
          <circle cx={g.x(m.d)} cy={H - PAD.b} r={3.5} fill={m.color} stroke="#fff" strokeWidth={1.5}>
            <title>{`${m.label}（${(m.d / 1000).toFixed(1)} km）`}</title>
          </circle>
        </g>
      ))}
      {hover && (
        <g>
          <line x1={g.x(hover.d)} x2={g.x(hover.d)} y1={PAD.t} y2={H - PAD.b} className="cursor" />
          <circle cx={g.x(hover.d)} cy={g.y(hover.e)} r={4} fill={color} />
          <text
            x={Math.min(g.x(hover.d) + 6, W - 120)}
            y={PAD.t + 12}
            className="tick hover-label"
          >
            {(hover.d / 1000).toFixed(2)} km · {Math.round(hover.e)} m
          </text>
        </g>
      )}
    </svg>
  );
}
