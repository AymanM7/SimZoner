"use client";

import { useStore } from "../store";
import { VEHICLES, vehicleById } from "../lib/vehicles";
import { CORRIDORS } from "../lib/corridors";
import type { VehicleState } from "../lib/types";
import { ModeBadge, Sparkline } from "./ui";
import { WinOdds } from "./WinOdds";
import metrics from "../data/model_metrics.json";

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

function fmtEta(sec: number) {
  if (!isFinite(sec) || sec <= 0) return "--:--";
  const m = Math.floor(sec / 60);
  return `${m}:${Math.floor(sec % 60).toString().padStart(2, "0")}`;
}

function fmtGap(sec: number) {
  if (!isFinite(sec) || sec <= 0) return "leader";
  if (sec < 60) return `+${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  return `+${m}:${Math.round(sec % 60).toString().padStart(2, "0")}`;
}

export function MLPredictor({ cars }: { cars: Record<string, VehicleState> }) {
  const { selectedVehicleId, selectVehicle, runPrediction, prediction, predictLoading, corridorId } = useStore();
  const corridor = CORRIDORS[corridorId];
  const sel = vehicleById(selectedVehicleId);
  const selCar = cars[selectedVehicleId];

  // Corridor label split: "I-45 Gulf Freeway (Downtown Houston to ...)" -> name + sub
  const [routeName, routeSubRaw] = corridor.displayName.split("(");
  const routeSub = routeSubRaw ? routeSubRaw.replace(/\)\s*$/, "").trim() : "";
  const hasHov = corridor.sections.some((s) => s.hovLanes > 0);
  const miles = Math.round(corridor.lengthKm * 0.621371);

  const ranked = VEHICLES.map((v) => ({ v, c: cars[v.id] })).sort((a, b) => a.c.etaSec - b.c.etaSec);
  const leadEta = ranked[0]?.c.etaSec ?? 0;
  const maxEta = Math.max(...ranked.map((r) => r.c.etaSec), 1);
  const myRank = ranked.findIndex((r) => r.v.id === selectedVehicleId) + 1;

  const showPrediction = prediction && prediction.vehicleId === selectedVehicleId;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <div className="eyebrow flex items-center gap-1.5">
            <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
            ML Predictor
          </div>
          <span className="tnum text-[10px] text-[var(--color-faint)]">P{myRank || "-"} / {VEHICLES.length}</span>
        </div>
        <h2 className="mt-0.5 text-lg font-semibold tracking-tight">Route optimizer &amp; leaderboard</h2>

        {/* Active corridor chip — makes it clear the prediction is per-route */}
        <div className="glass-soft mt-2 flex items-center gap-2.5 px-2.5 py-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" />
              <circle cx="12" cy="9" r="2.5" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold leading-tight">{routeName.trim()}</div>
            {routeSub && <div className="truncate text-[10px] text-[var(--color-muted)]">{routeSub}</div>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="tnum text-[11px] font-semibold text-[var(--color-ink)]">{miles} mi</span>
            <span
              className="rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide"
              style={
                hasHov
                  ? { color: "var(--color-good)", background: "color-mix(in srgb, var(--color-good) 14%, transparent)" }
                  : { color: "var(--color-faint)", background: "color-mix(in srgb, var(--color-faint) 16%, transparent)" }
              }
            >
              {hasHov ? "HOV" : "No HOV"}
            </span>
          </div>
        </div>
      </div>

      {/* Vehicle selector — prominent segmented toggle */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint)]">Select vehicle</span>
          <span className="text-[10px] text-[var(--color-faint)]">drives the panel</span>
        </div>
        <div className="glass-soft grid grid-cols-3 gap-1 p-1">
          {VEHICLES.map((v) => {
            const active = selectedVehicleId === v.id;
            return (
              <button
                key={v.id}
                onClick={() => selectVehicle(v.id)}
                className="group relative flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-xs font-semibold transition-all duration-200"
                style={
                  active
                    ? {
                        background: `color-mix(in srgb, ${v.color} 16%, transparent)`,
                        color: v.color,
                        border: `1px solid color-mix(in srgb, ${v.color} 50%, transparent)`,
                        boxShadow: `0 0 20px -8px ${v.color}`,
                      }
                    : { color: "var(--color-muted)", border: "1px solid transparent" }
                }
              >
                <span
                  className="h-2 w-2 rounded-full transition-transform duration-200 group-hover:scale-110"
                  style={{ background: v.color, opacity: active ? 1 : 0.55, boxShadow: active ? `0 0 8px ${v.color}` : "none" }}
                />
                <span className="leading-tight">{v.short}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected vehicle hero + predict */}
      <div
        className="glass p-3 transition-shadow duration-300"
        style={{ boxShadow: `0 0 0 1px color-mix(in srgb, ${sel.color} 40%, transparent), 0 0 30px -12px ${sel.color}` }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ background: sel.color, boxShadow: `0 0 10px ${sel.color}` }} />
            <span className="text-sm font-semibold">{sel.name}</span>
          </div>
          <ModeBadge mode={selCar?.mode ?? sel.defaultMode} />
        </div>
        <p className="mt-1 text-[12px] leading-snug text-[var(--color-muted)]">{sel.behavior}</p>

        {/* Progress along route */}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--color-faint)]">
            <span className="uppercase tracking-wider">Route progress</span>
            <span className="tnum text-[var(--color-muted)]">{Math.round((selCar?.progress ?? 0) * 100)}%</span>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-[var(--color-line)]">
            <div
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out"
              style={{
                width: `${Math.min(100, Math.max(2, (selCar?.progress ?? 0) * 100))}%`,
                background: `linear-gradient(90deg, color-mix(in srgb, ${sel.color} 55%, transparent), ${sel.color})`,
              }}
            />
          </div>
        </div>

        {/* Telemetry */}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {[
            { label: "mph", value: `${Math.round(selCar?.speedMph ?? 0)}`, color: sel.color },
            { label: "energy", value: `${Math.round(selCar?.batteryPct ?? 100)}%` },
            { label: "eta", value: fmtEta(selCar?.etaSec ?? 0) },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border border-[var(--color-line-soft)] bg-white/[0.015] px-2 py-1.5 text-center">
              <div className="tnum text-lg font-semibold leading-none" style={{ color: s.color ?? "var(--color-ink)" }}>
                {s.value}
              </div>
              <div className="mt-1 text-[9px] uppercase tracking-wide text-[var(--color-faint)]">{s.label}</div>
            </div>
          ))}
        </div>

        <button
          onClick={() => runPrediction(selectedVehicleId, cars)}
          disabled={predictLoading}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg py-2 text-xs font-semibold transition active:scale-[0.99] disabled:opacity-60"
          style={{
            background: `color-mix(in srgb, ${sel.color} 16%, transparent)`,
            color: sel.color,
            border: `1px solid color-mix(in srgb, ${sel.color} 50%, transparent)`,
          }}
        >
          {predictLoading ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Computing route...
            </>
          ) : (
            `Predict optimal route for ${sel.short}`
          )}
        </button>
      </div>

      {/* Prediction output */}
      {showPrediction && (
        <div className="glass-soft p-3" style={{ boxShadow: `inset 2px 0 0 ${sel.color}` }}>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="eyebrow">Recommended Route</span>
            <span
              className="tnum inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-wide"
              style={
                prediction!.usedVectorize
                  ? { background: "color-mix(in srgb, var(--color-good) 14%, transparent)", color: "var(--color-good)", border: "1px solid color-mix(in srgb, var(--color-good) 45%, transparent)" }
                  : { background: "color-mix(in srgb, var(--color-faint) 18%, transparent)", color: "var(--color-muted)", border: "1px solid var(--color-line)" }
              }
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: prediction!.usedVectorize ? "var(--color-good)" : "var(--color-faint)" }}
              />
              {prediction!.usedVectorize ? `VECTORIZE - ${prediction!.retrievedDocs.length} docs` : "LOCAL FALLBACK"}
            </span>
          </div>
          <p className="text-[13px] font-medium leading-snug">{prediction!.recommendedSegment}</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-muted)]">{prediction!.rationale}</p>
          {prediction!.usedVectorize && prediction!.retrievedDocs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {prediction!.retrievedDocs.slice(0, 4).map((d) => (
                <span key={d.id} className="tnum rounded bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-[var(--color-faint)]">
                  {d.id} - {(d.score * 100).toFixed(0)}%
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Leaderboard */}
      <div className="glass-soft p-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Live Leaderboard</span>
          <span className="text-[10px] text-[var(--color-faint)]">modeled arrival order</span>
        </div>
        <div className="mt-2.5 flex flex-col gap-1">
          {ranked.map(({ v, c }, i) => {
            const isSel = v.id === selectedVehicleId;
            const isLead = i === 0;
            const barPct = Math.max(6, (1 - (c.etaSec - leadEta) / Math.max(1, maxEta - leadEta || 1)) * 100);
            return (
              <div
                key={v.id}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors"
                style={
                  isSel
                    ? { background: `color-mix(in srgb, ${v.color} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${v.color} 35%, transparent)` }
                    : { border: "1px solid transparent" }
                }
              >
                <span
                  className="tnum grid h-5 w-5 shrink-0 place-items-center rounded-md text-[10px] font-bold"
                  style={
                    isLead
                      ? { background: `color-mix(in srgb, ${v.color} 20%, transparent)`, color: v.color }
                      : { background: "var(--color-line)", color: "var(--color-muted)" }
                  }
                >
                  {i + 1}
                </span>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: v.color, boxShadow: isSel ? `0 0 6px ${v.color}` : "none" }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span className="truncate text-xs font-semibold" style={{ color: isSel ? v.color : "var(--color-ink)" }}>
                      {v.short}
                    </span>
                    <span className="tnum text-[10px] text-[var(--color-faint)]">{isLead ? "leader" : fmtGap(c.etaSec - leadEta)}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--color-line)]">
                    <div className="h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${barPct}%`, background: v.color, opacity: isSel ? 1 : 0.6 }} />
                  </div>
                </div>
                <div className="h-7 w-[64px] shrink-0">
                  <Sparkline data={c.history} color={v.color} height={26} fill={false} strokeWidth={1.4} />
                </div>
                <span className="tnum w-11 shrink-0 text-right text-xs font-semibold">{fmtEta(c.etaSec)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Live win odds — client-side Monte Carlo over the ETA bands (zero neurons) */}
      <WinOdds cars={cars} />

      {/* Model — one place: trained models, overall metrics, per-vehicle */}
      <div className="glass-soft p-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Model</span>
          <span className="text-[10px] text-[var(--color-faint)]">held-out test set</span>
        </div>

        {/* Overall headline metrics */}
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[var(--color-line-soft)] bg-white/[0.015] px-3 py-2.5">
            <div className="text-[9px] uppercase tracking-wider text-[var(--color-faint)]">Accuracy</div>
            <div className="tnum mt-1 text-2xl font-semibold leading-none text-[var(--color-ink)]">
              {(metrics.overall.test_accuracy * 100).toFixed(1)}
              <span className="text-sm font-medium opacity-60">%</span>
            </div>
            <div className="tnum mt-1.5 text-[10px] text-[var(--color-faint)]">
              vs {pct(metrics.overall.majority_baseline)} baseline
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-line-soft)] bg-white/[0.015] px-3 py-2.5">
            <div className="text-[9px] uppercase tracking-wider text-[var(--color-faint)]">AUC</div>
            <div className="tnum mt-1 text-2xl font-semibold leading-none text-[var(--color-accent)]">
              {metrics.overall.auc.toFixed(3)}
            </div>
            <div className="mt-1.5 text-[10px] text-[var(--color-faint)]">ranking quality</div>
          </div>
        </div>

        {/* Trained models */}
        <div className="mt-3 border-t border-[var(--color-line-soft)] pt-3">
          <div className="mb-2 text-[9px] font-medium uppercase tracking-wider text-[var(--color-faint)]">Trained</div>
          <div className="flex flex-col gap-2">
            {metrics.models.map((m) => (
              <div key={m.name} className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium text-[var(--color-ink)]">{m.name}</span>
                  <span
                    className="shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide"
                    style={
                      m.role === "shipped"
                        ? { color: "var(--color-good)", background: "color-mix(in srgb, var(--color-good) 14%, transparent)" }
                        : { color: "var(--color-muted)", background: "color-mix(in srgb, var(--color-faint) 16%, transparent)" }
                    }
                  >
                    {m.role}
                  </span>
                </div>
                <span className="tnum shrink-0 text-[12px] font-semibold">{pct(m.test_accuracy)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Per-vehicle — AUC is the metric to trust */}
        <div className="mt-3 border-t border-[var(--color-line-soft)] pt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[9px] font-medium uppercase tracking-wider text-[var(--color-faint)]">Per-vehicle</span>
            <span className="text-[9px] uppercase tracking-wider text-[var(--color-faint)]">acc / auc</span>
          </div>
          <div className="flex flex-col gap-1">
            {VEHICLES.map((v) => {
              const pc = metrics.per_car.find((p) => p.id === v.id);
              if (!pc) return null;
              return (
                <div key={v.id} className="flex items-center gap-2.5 py-0.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: v.color }} />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--color-ink)]">{pc.name}</span>
                  <span className="tnum w-12 text-right text-[12px] text-[var(--color-muted)]">{pct(pc.accuracy)}</span>
                  <span className="tnum w-10 text-right text-[12px] font-semibold text-[var(--color-accent)]">{pc.auc.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2.5 text-[10px] leading-relaxed text-[var(--color-faint)]">
            AUC is the metric to trust here: accuracy flatters lopsided matchups where it sits near the {pct(metrics.overall.majority_baseline, 0)} baseline. {metrics.note}
          </p>
        </div>
      </div>
    </div>
  );
}
