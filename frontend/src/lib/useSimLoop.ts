import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { CORRIDORS } from "./corridors";
import { advance, freshCars } from "./engine";
import type { VehicleState } from "./types";

// The coordinate stream. Owns a mutable cars ref advanced every animation frame
// (read imperatively by the map for smooth motion) and pushes a throttled snapshot
// into React for the panels. City switching resets the stream instantly.
//
// Determinism: each race has a seed = `${corridorId}:${raceNonce}`. Weather is drawn
// once per race (on reset) and every per-segment event in the tick comes from the same
// seed, so a given corridor + raceNonce always replays the identical race.
export function useSimLoop() {
  const corridorId = useStore((s) => s.corridorId);
  const raceNonce = useStore((s) => s.raceNonce);
  const seed = `${corridorId}:${raceNonce}`;
  const seedRef = useRef<string>(seed);
  const carsRef = useRef<Record<string, VehicleState>>(freshCars(CORRIDORS[corridorId], seed));
  const [snapshot, setSnapshot] = useState<Record<string, VehicleState>>(carsRef.current);
  const lastRef = useRef<number>(0);
  const pushRef = useRef<number>(0);

  // reset cars to the start line on city change OR when a race is (re)started via Predict
  useEffect(() => {
    seedRef.current = seed;
    carsRef.current = freshCars(CORRIDORS[corridorId], seed);
    setSnapshot(structuredClone(carsRef.current));
  }, [corridorId, raceNonce, seed]);

  useEffect(() => {
    let raf = 0;
    lastRef.current = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - lastRef.current) / 1000);
      lastRef.current = now;
      const { running, incidentAt } = useStore.getState();
      if (running) advance(carsRef.current, CORRIDORS[corridorId], dt, incidentAt, seedRef.current);

      if (now - pushRef.current > 200) {
        pushRef.current = now;
        for (const id of Object.keys(carsRef.current)) {
          const c = carsRef.current[id];
          c.history.push(c.speedMph);
          if (c.history.length > 40) c.history.shift();
        }
        setSnapshot(structuredClone(carsRef.current));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [corridorId]);

  return { carsRef, snapshot };
}
