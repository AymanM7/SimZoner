"use client";

import dynamic from "next/dynamic";
import { useStore } from "../store";
import { useSimLoop } from "../lib/useSimLoop";
import { CORRIDOR_LIST } from "../lib/corridors";
import { MLPredictor } from "../components/MLPredictor";

// MapLibre touches window -> client-only, no SSR.
const HighwayMap = dynamic(() => import("../components/HighwayMap").then((m) => m.HighwayMap), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-[var(--color-muted)]">Loading map…</div>,
});

export default function Page() {
  const { carsRef, snapshot } = useSimLoop();
  const { corridorId, setCorridor, running, toggleRunning, triggerIncident, incidentAt, clearIncident, mapTheme, toggleMapTheme } =
    useStore();
  const corridor = CORRIDOR_LIST.find((c) => c.id === corridorId)!;

  const leaderProgress = Math.max(...Object.values(snapshot).map((c) => c.progress));

  return (
    <main className="mx-auto flex min-h-screen max-w-[1500px] flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl text-[var(--color-accent)] glow-cyan">◈</div>
          <div>
            <div className="eyebrow">SimZoner · Predictive AV Routing</div>
            <h1 className="text-xl font-semibold tracking-tight">Autonomous Routing & HOV Optimization</h1>
          </div>
        </div>
        <div className="glass-soft flex overflow-hidden rounded-xl p-1">
          {CORRIDOR_LIST.map((c) => (
            <button
              key={c.id}
              onClick={() => setCorridor(c.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                c.id === corridorId ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              {c.displayName.split("(")[0].trim()}
            </button>
          ))}
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_390px]">
        <section className="glass relative flex min-h-[560px] flex-col overflow-hidden">
          <div className="relative z-10 flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="rounded-lg bg-[var(--color-ground)]/70 px-3 py-2 backdrop-blur">
              <div className="eyebrow">Highway Plate · Live</div>
              <div className="text-sm font-semibold">{corridor.displayName}</div>
              <div className="tnum text-[11px] text-[var(--color-muted)]">
                {corridor.lengthKm.toFixed(0)} km · {corridor.sections.length} sections
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={toggleMapTheme}
                className="glass-soft rounded-lg px-3 py-1.5 text-xs font-medium backdrop-blur hover:text-[var(--color-accent)]"
                title="Toggle OpenStreetMap light/dark"
              >
                {mapTheme === "light" ? "🌙 Dark map" : "☀ Light map"}
              </button>
              <button onClick={toggleRunning} className="glass-soft rounded-lg px-3 py-1.5 text-xs font-medium backdrop-blur hover:text-[var(--color-accent)]">
                {running ? "Pause" : "Resume"}
              </button>
              {incidentAt === null ? (
                <button
                  onClick={() => triggerIncident(Math.min(0.85, leaderProgress + 0.1))}
                  className="rounded-lg border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/15 px-3 py-1.5 text-xs font-semibold text-[var(--color-bad)] backdrop-blur hover:bg-[var(--color-bad)]/25"
                >
                  ⚠ Inject incident
                </button>
              ) : (
                <button onClick={clearIncident} className="glass-soft rounded-lg px-3 py-1.5 text-xs font-medium backdrop-blur">
                  Clear incident
                </button>
              )}
            </div>
          </div>
          <div className="relative h-[540px]">
            <HighwayMap carsRef={carsRef} />
          </div>
        </section>

        <aside className="glass min-h-[560px] p-4">
          <MLPredictor cars={snapshot} />
        </aside>
      </div>

      <footer className="text-[11px] text-[var(--color-faint)]">
        Real Esri satellite imagery · real I-45 &amp; Cincinnati geometry · real published specs · modeled traffic (not live).
        Vectorize powers the route recommendation when the backend is reachable.
      </footer>
    </main>
  );
}
