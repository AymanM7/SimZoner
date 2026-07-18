import type { Mode } from "../lib/types";

const MODE_COLOR: Record<Mode, string> = {
  Manual: "var(--color-warn)",
  Autopilot: "var(--color-accent)",
  FSD: "var(--color-good)",
};

const MODE_GLYPH: Record<Mode, string> = {
  Manual: "MANUAL",
  Autopilot: "AUTOPILOT",
  FSD: "FSD",
};

export function ModeBadge({ mode }: { mode: Mode }) {
  const c = MODE_COLOR[mode];
  return (
    <span
      className="tnum inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider"
      style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 45%, transparent)` }}
    >
      <span className="live-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {MODE_GLYPH[mode]}
    </span>
  );
}

export function Sparkline({
  data,
  color,
  height = 34,
  fill = true,
  strokeWidth = 1.6,
}: {
  data: number[];
  color: string;
  height?: number;
  fill?: boolean;
  strokeWidth?: number;
}) {
  const w = 150;
  if (data.length < 2) return <svg width="100%" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = Math.max(1, max - min);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = height - ((v - min) / span) * (height - 6) - 3;
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const id = `g${color.replace(/[^a-z0-9]/gi, "")}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="block">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.38" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={`${line} L${w},${height} L0,${height} Z`} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="3.4" fill={color} opacity="0.25" />
      <circle cx={lx} cy={ly} r="2.1" fill={color} />
    </svg>
  );
}

export function Gauge({
  value,
  label,
  sub,
  color,
}: {
  value: number;
  label: string;
  sub?: string;
  color?: string;
}) {
  const r = 42;
  const clamped = Math.max(0, Math.min(1, value));
  const a = Math.PI * (1 - clamped);
  const x = 50 + r * Math.cos(a);
  const y = 50 - r * Math.sin(a);
  const large = clamped > 0.5 ? 1 : 0;
  const col = color ?? (clamped > 0.66 ? "var(--color-good)" : clamped > 0.4 ? "var(--color-warn)" : "var(--color-bad)");
  return (
    <div className="flex w-full flex-col items-center">
      <svg viewBox="0 0 100 56" className="w-full max-w-[132px]">
        <path d="M8 50 A42 42 0 0 1 92 50" fill="none" stroke="var(--color-line)" strokeWidth="7" strokeLinecap="round" />
        <path
          d={`M8 50 A42 42 0 ${large} 1 ${x.toFixed(1)} ${y.toFixed(1)}`}
          fill="none"
          stroke={col}
          strokeWidth="7"
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 5px color-mix(in srgb, ${col} 55%, transparent))`, transition: "all 0.6s cubic-bezier(0.22, 1, 0.36, 1)" }}
        />
        <circle cx={x.toFixed(1)} cy={y.toFixed(1)} r="3.2" fill={col} />
      </svg>
      <div className="tnum -mt-2 text-2xl font-semibold leading-none" style={{ color: col }}>
        {Math.round(clamped * 100)}
        <span className="text-sm font-medium opacity-70">%</span>
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      {sub && <div className="text-[10px] text-[var(--color-faint)]">{sub}</div>}
    </div>
  );
}
