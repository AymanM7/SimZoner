import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { CORRIDORS } from "./corridors";
import { advance, freshCars } from "./engine";
import type { VehicleState } from "./types";

// The coordinate stream. Owns a mutable cars ref advanced every animation frame
// (read imperatively by the map for smooth motion) and pushes a throttled snapshot
// into React for the panels. City switching resets the stream instantly.
export function useSimLoop() {
  const corridorId = useStore((s) => s.corridorId);
  const carsRef = useRef<Record<string, VehicleState>>(freshCars(CORRIDORS[corridorId]));
  const [snapshot, setSnapshot] = useState<Record<string, VehicleState>>(carsRef.current);
  const lastRef = useRef<number>(0);
  const pushRef = useRef<number>(0);

  // reset on city change
  useEffect(() => {
    carsRef.current = freshCars(CORRIDORS[corridorId]);
    setSnapshot(structuredClone(carsRef.current));
  }, [corridorId]);

  useEffect(() => {
    let raf = 0;
    lastRef.current = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - lastRef.current) / 1000);
      lastRef.current = now;
      const { running, incidentAt } = useStore.getState();
      if (running) advance(carsRef.current, CORRIDORS[corridorId], dt, incidentAt);

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
