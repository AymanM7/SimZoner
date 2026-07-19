"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { CORRIDORS } from "../lib/corridors";
import { vehicleById } from "../lib/vehicles";
import { WEATHER } from "../lib/engine";
import type { VehicleState } from "../lib/types";

type Tone = "flag" | "lead" | "pass" | "hov" | "warn" | "finish" | "info";
interface Line {
  id: number;
  t: string; // race clock mm:ss
  text: string;
  tone: Tone;
  color?: string;
}

const TONE_COLOR: Record<Tone, string> = {
  flag: "var(--color-good)",
  lead: "var(--color-accent)",
  pass: "var(--color-ink)",
  hov: "var(--color-good)",
  warn: "var(--color-bad)",
  finish: "var(--color-warn)",
  info: "var(--color-muted)",
};

// Persona-flavored verbs so the play-by-play stays in character (persona.ts voices).
const PASS_VERB: Record<string, string> = {
  "cybertruck-cyberbeast": "muscles past",
  "bmw-m5-g90": "slices past",
  "waymo-ipace": "eases past",
};
const short = (id: string) => vehicleById(id).short;

function clock(sinceMs: number): string {
  const s = Math.max(0, Math.floor(sinceMs / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

// Order car ids by physical progress (furthest along = leader).
function orderByProgress(cars: Record<string, VehicleState>): string[] {
  return Object.keys(cars).sort((a, b) => cars[b].progress - cars[a].progress);
}

// Live, rule-based, TEXT-ONLY race commentary. Detects events by diffing the sim
// snapshot frame-to-frame. Fully client-side -- no Workers AI, no network.
export function CommentaryFeed({ cars }: { cars: Record<string, VehicleState> }) {
  const corridorId = useStore((s) => s.corridorId);
  const raceNonce = useStore((s) => s.raceNonce);
  const [lines, setLines] = useState<Line[]>([]);
  const prevRef = useRef<Record<string, VehicleState> | null>(null);
  const startRef = useRef<number>(performance.now());
  const idRef = useRef<number>(0);
  const lastMinorRef = useRef<number>(0);

  const push = (text: string, tone: Tone, color?: string) => {
    const line: Line = { id: idRef.current++, t: clock(performance.now() - startRef.current), text, tone, color };
    setLines((prev) => [line, ...prev].slice(0, 12));
  };

  // Green flag on (re)start: reset the feed and post the opening + weather lines.
  useEffect(() => {
    startRef.current = performance.now();
    prevRef.current = null;
    lastMinorRef.current = 0;
    setLines([]);
    idRef.current = 0;
    const name = CORRIDORS[corridorId].displayName.split("(")[0].trim();
    const anyCar = Object.values(cars)[0];
    const w = anyCar ? WEATHER[anyCar.weather] : null;
    // stagger so the two opening lines don't collide on the same id/order
    push(`Lights out -- green flag on ${name}.`, "flag");
    if (w) push(`Track conditions: ${w.label.toLowerCase()}${anyCar!.weather === "clear" ? " skies" : ""}.`, "info");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceNonce, corridorId]);

  // Diff the snapshot for events.
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = cars;
    if (!prev) return;

    const now = performance.now();
    const started = Object.values(cars).some((c) => c.progress > 0.02);
    if (!started) return;

    // Finishes (always reported).
    for (const id of Object.keys(cars)) {
      if (cars[id].finished && prev[id] && !prev[id].finished) {
        const pos = orderByProgress(cars).indexOf(id) + 1;
        const label = pos === 1 ? "takes the checkered flag" : `crosses the line P${pos}`;
        push(`${short(id)} ${label}!`, "finish", vehicleById(id).color);
      }
    }

    // Incidents / driver errors (always reported).
    for (const id of Object.keys(cars)) {
      if (cars[id].incident && prev[id] && !prev[id].incident && !cars[id].finished) {
        push(`Trouble for ${short(id)} -- losing time on the road.`, "warn", vehicleById(id).color);
      }
    }

    // HOV entry (debounced with the other minor events).
    for (const id of Object.keys(cars)) {
      if (cars[id].onHov && prev[id] && !prev[id].onHov && !cars[id].finished) {
        if (now - lastMinorRef.current > 900) {
          lastMinorRef.current = now;
          push(`${short(id)} slips into the HOV lane and clears the traffic.`, "hov", vehicleById(id).color);
        }
      }
    }

    // Lead change (leader = furthest along). Reported over overtakes.
    const orderNow = orderByProgress(cars);
    const orderPrev = orderByProgress(prev);
    if (orderNow[0] !== orderPrev[0] && cars[orderNow[0]].progress > 0.03 && !cars[orderNow[0]].finished) {
      push(`${short(orderNow[0])} takes the lead from ${short(orderPrev[0])}!`, "lead", vehicleById(orderNow[0]).color);
    } else if (now - lastMinorRef.current > 900) {
      // Non-lead overtake: a car that gained a position.
      for (let i = 1; i < orderNow.length; i++) {
        const id = orderNow[i];
        const gained = orderPrev.indexOf(id) > i; // was lower, now higher
        if (gained && !cars[id].finished && cars[id].progress > 0.03) {
          const passed = orderPrev[i]; // the car now behind it
          if (passed && passed !== id) {
            lastMinorRef.current = now;
            push(`${short(id)} ${PASS_VERB[id] ?? "passes"} ${short(passed)} for P${i + 1}.`, "pass", vehicleById(id).color);
          }
          break;
        }
      }
    }
  }, [cars]);

  return (
    <div className="glass flex min-h-[180px] flex-col p-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow flex items-center gap-1.5">
          <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
          Live Commentary
        </span>
        <span className="text-[10px] text-[var(--color-faint)]">rule-based play-by-play</span>
      </div>
      <div className="mt-2.5 flex flex-1 flex-col gap-1.5 overflow-y-auto">
        {lines.length === 0 && (
          <p className="text-[12px] text-[var(--color-faint)]">Waiting for the green flag...</p>
        )}
        {lines.map((l) => (
          <div key={l.id} className="flex items-start gap-2 text-[12px] leading-snug">
            <span className="tnum mt-px shrink-0 text-[10px] text-[var(--color-faint)]">{l.t}</span>
            <span
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: l.color ?? TONE_COLOR[l.tone] }}
            />
            <span style={{ color: l.tone === "info" ? "var(--color-muted)" : "var(--color-ink)" }}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
