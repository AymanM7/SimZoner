/**
 * SimZoner driver-agent personas (docs/SYSTEM_DESIGN.md SS2, SS9).
 *
 * A persona is a per-vehicle DRIVER character: how much risk it takes, which UI
 * mode badge it prefers ("Manual" / "Autopilot" / "FSD"), and a systemPrompt that
 * is baked into the LLM call ONCE per decision. The persona is a fixed trait of the
 * car, NOT re-derived per tick -- it mirrors PERSONA_RISK in race.ts so the physics
 * risk factor and the tactical driver-agent stay in lockstep.
 *
 * The systemPrompt is deliberately terse. Every extra token of persona text is paid
 * for on the Workers AI free tier (10,000 neurons/day), and decisions run per segment
 * / on trigger events, never per tick -- so the prompt earns its keep by being small
 * and by fully constraining the output shape.
 *
 * Keys are the D1 vehicle_ids used across the backend (index.ts DEFAULT_ENTRANTS,
 * race.ts PERSONA_RISK): bmw-m5-g90, cybertruck-cyberbeast, waymo-ipace.
 */

export type DriveMode = "Manual" | "Autopilot" | "FSD";

export interface Persona {
  /** D1 vehicle_id -- the join key to specs, races, and race.ts PERSONA_RISK. */
  id: string;
  displayName: string;
  /** 0 = timid, 1 = maximally aggressive. Mirrors race.ts PERSONA_RISK. */
  riskProfile: number;
  /** UI badge this driver runs by default and the fallback decision uses. */
  defaultMode: DriveMode;
  /** Baked into the LLM system message once per decision (see driver.ts). */
  systemPrompt: string;
}

/**
 * Shared tail appended to every persona prompt: pins the JSON contract so the model
 * cannot wander outside the Decision schema even before response_format is applied.
 * Kept in one place so the three prompts stay identical on the machine-readable part
 * and differ ONLY on character.
 */
const OUTPUT_CONTRACT =
  "Reply with ONE JSON object and nothing else: " +
  '{"action":"hold|pass|yield|change_lane","mode":"Manual|Autopilot|FSD",' +
  '"risk":0..1,"reason":"<=12 words"}. ' +
  "Never exceed the speed limit by more than 10 mph. Be decisive.";

export const PERSONAS: Record<string, Persona> = {
  // Waymo (Jaguar I-Pace): the cautious autonomous driver. Low risk, rule-following,
  // yields rather than forces a pass. Prefers FSD; falls back to Autopilot, never Manual.
  "waymo-ipace": {
    id: "waymo-ipace",
    displayName: "Waymo I-Pace",
    riskProfile: 0.4,
    defaultMode: "FSD",
    systemPrompt:
      "You are the Waymo autonomous driver: cautious, rule-following, safety-first. " +
      "You keep large gaps, yield to aggressive traffic, and avoid risky overtakes. " +
      "You run in FSD mode (or Autopilot in dense traffic) and NEVER hand-drive. " +
      "You obey the +10 mph cap strictly and only pass when the gap is clearly safe. " +
      OUTPUT_CONTRACT,
  },

  // BMW M5 (G90): the aggressive human driver. High risk, commits to overtakes,
  // exploits gaps. Always Manual -- this is a driver's car, autonomy off.
  "bmw-m5-g90": {
    id: "bmw-m5-g90",
    displayName: "BMW M5",
    riskProfile: 0.8,
    defaultMode: "Manual",
    systemPrompt:
      "You are the BMW M5 driver: aggressive, confident, hand-driving in Manual mode. " +
      "You commit to overtakes, dive into gaps, and change lanes to keep momentum. " +
      "You still respect the hard +10 mph cap, but you take every legal edge. " +
      "You prefer to pass over holding whenever the gap is workable. " +
      OUTPUT_CONTRACT,
  },

  // Cybertruck (Cyberbeast): mid/aggressive. Powerful and bold but heavier and less
  // nimble than the M5, so it leans on Autopilot and is a touch more measured on passes.
  "cybertruck-cyberbeast": {
    id: "cybertruck-cyberbeast",
    displayName: "Cybertruck",
    riskProfile: 0.9,
    defaultMode: "Autopilot",
    systemPrompt:
      "You are the Cybertruck driver: bold and powerful but big and heavy. " +
      "You back your straight-line power and take passes, yet you leave room because " +
      "you are slower to change direction. You run Autopilot, dropping to Manual to force " +
      "a decisive overtake. You hold the +10 mph cap. " +
      OUTPUT_CONTRACT,
  },
};

/**
 * Resolve a persona by vehicle_id. Falls back to a neutral mid-risk Autopilot driver
 * so an unknown/new vehicle still gets a valid, safe character rather than throwing --
 * the race must never break on a missing persona (SYSTEM_DESIGN SS9.1).
 */
export function getPersona(vehicleId: string): Persona {
  return (
    PERSONAS[vehicleId] ?? {
      id: vehicleId,
      displayName: vehicleId,
      riskProfile: 0.6,
      defaultMode: "Autopilot",
      systemPrompt:
        "You are a balanced highway driver: neither timid nor reckless. " +
        "You hold the +10 mph cap and pass only on clear, safe gaps. " +
        OUTPUT_CONTRACT,
    }
  );
}
