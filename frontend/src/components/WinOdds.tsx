"use client";

import { useMemo, useState } from "react";
import { VEHICLES } from "../lib/vehicles";
import type { VehicleState } from "../lib/types";
import { winProbabilities, toDecimalOdds, toAmericanOdds } from "../lib/odds";

type OddsFmt = "pct" | "dec" | "us";

function fmtOdds(p: number, fmt: OddsFmt): string {
  if (fmt === "pct") return `${Math.round(p * 100)}%`;
  if (fmt === "dec") {
    const d = toDecimalOdds(p);
    return isFinite(d) ? d.toFixed(2) : "--";
  }
  return toAmericanOdds(p);
}

// Live win-probability bars: a client-side Monte Carlo over each car's ETA band, run
// every render off the live snapshot. No backend, no neurons.
export function WinOdds({ cars }: { cars: Record<string, VehicleState> }) {
  const [fmt, setFmt] = useState<OddsFmt>("pct");
  const probs = useMemo(() => winProbabilities(cars), [cars]);
  const ranked = useMemo(
    () => VEHICLES.map((v) => ({ v, p: probs[v.id] ?? 0 })).sort((a, b) => b.p - a.p),
    [probs]
  );

  const cycle: OddsFmt[] = ["pct", "dec", "us"];
  const nextFmt = () => setFmt((f) => cycle[(cycle.indexOf(f) + 1) % cycle.length]);
  const fmtLabel = fmt === "pct" ? "%" : fmt === "dec" ? "DEC" : "US";

  return (
    <div className="glass-soft p-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow flex items-center gap-1.5">
          <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
          Live Win Odds
        </span>
        <button
          onClick={nextFmt}
          className="tnum rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-muted)] transition hover:text-[var(--color-accent)]"
          title="Toggle probability / decimal / American odds"
        >
          {fmtLabel}
        </button>
      </div>
      <div className="mt-2.5 flex flex-col gap-2">
        {ranked.map(({ v, p }, i) => (
          <div key={v.id} className="flex items-center gap-2">
            <span
              className="tnum grid h-5 w-5 shrink-0 place-items-center rounded-md text-[10px] font-bold"
              style={
                i === 0
                  ? { background: `color-mix(in srgb, ${v.color} 20%, transparent)`, color: v.color }
                  : { background: "var(--color-line)", color: "var(--color-muted)" }
              }
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="truncate text-xs font-semibold" style={{ color: v.color }}>
                  {v.short}
                </span>
                <span className="tnum text-[11px] font-semibold" style={{ color: v.color }}>
                  {fmtOdds(p, fmt)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]">
                <div
                  className="h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{
                    width: `${Math.max(2, p * 100)}%`,
                    background: `linear-gradient(90deg, color-mix(in srgb, ${v.color} 55%, transparent), ${v.color})`,
                    boxShadow: `0 0 8px -2px ${v.color}`,
                  }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-[10px] leading-relaxed text-[var(--color-faint)]">
        Monte Carlo over the ETA uncertainty band (1,200 draws/frame). Client-side, zero neurons.
      </p>
    </div>
  );
}
