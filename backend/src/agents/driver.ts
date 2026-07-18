/**
 * SimZoner per-vehicle DRIVER AGENT -- the tactical brain (docs/SYSTEM_DESIGN.md SS9).
 *
 * Given a race Situation, a driver agent makes ONE tactical Decision: hold / pass /
 * yield / change_lane, plus the UI drive-mode badge (Manual / Autopilot / FSD) and a
 * risk read. These decisions drive the UI badges and the lane-change/overtake behavior.
 *
 * ---------------------------------------------------------------------------------
 * WHY env.AI directly, not LangChain's chat class (verified; do not re-litigate):
 *   LangChain's `ChatCloudflareWorkersAI` is REST-only and CANNOT do tool-calling or
 *   structured output. For GENERATION we therefore call the Workers AI binding
 *   directly -- `env.AI.run(model, { messages, response_format: { type: "json_schema",
 *   json_schema }})` -- which supports native JSON-mode structured output. This IS the
 *   LangChain-orchestrated design: LangChain owns the RAG/retrieval layer (src/rag/,
 *   another agent), env.AI owns generation. The retrieved spec context arrives here as
 *   the injected `specContext` STRING (dependency injection) -- no import coupling to RAG.
 *
 * NEURON BUDGET (free tier = 10,000 neurons/day, ARCHITECTURE SS7):
 *   - Model tier: @cf/meta/llama-3.1-8b-instruct is the default -- big enough to reason
 *     about a gap/closing-speed tradeoff yet cheap. A 1B tier exists for routine calls;
 *     8B is chosen here because the persona/tactics reasoning is the whole point.
 *   - max_tokens = 120: a Decision is a tiny JSON object; capping output hard is the
 *     single biggest neuron lever, so we cap aggressively.
 *   - Cadence: decide() is called PER SEGMENT or on trigger events (a closing car, a
 *     lane opening) -- NEVER per physics tick. The tick loop stays deterministic and
 *     LLM-free (SYSTEM_DESIGN SS5); the agent only nudges tactics at segment boundaries.
 * ---------------------------------------------------------------------------------
 */

import { getPersona, type DriveMode, type Persona } from "./persona";

// 8B instruct: the reasoning tier. Swap to "@cf/meta/llama-3.2-1b-instruct" for
// routine, low-stakes segments if the daily neuron budget gets tight.
const DECISION_MODEL = "@cf/meta/llama-3.1-8b-instruct" as const;

// Hard output cap -- a Decision is a few dozen tokens; 120 leaves slack for the reason.
const MAX_TOKENS = 120;

export type Action = "hold" | "pass" | "yield" | "change_lane";

/** The race situation handed to a driver agent at a segment boundary / trigger. */
export interface Situation {
  vehicleId: string;
  segmentName: string;
  /** Distance to the car ahead, metres. */
  gapAheadM: number;
  /** Positive = we are catching the car ahead, metres/second. */
  closingSpeedMps: number;
  /** Current lane index (0 = leftmost/fastest by convention). */
  lane: number;
  /** Number of HOV lanes available on this segment. */
  hovLanes: number;
  /** 0 = empty road, 1 = jammed. */
  trafficDensity: number;
  speedLimitMph: number;
}

/** One tactical decision. `mode` feeds the UI badge; `action` feeds movement. */
export interface Decision {
  action: Action;
  mode: DriveMode;
  /** Model/persona risk read, clamped 0..1. */
  risk: number;
  reason: string;
}

const ACTIONS: readonly Action[] = ["hold", "pass", "yield", "change_lane"];
const MODES: readonly DriveMode[] = ["Manual", "Autopilot", "FSD"];

/**
 * JSON-schema handed to Workers AI's native structured-output mode. Constrains the
 * model to exactly the Decision shape so we get parseable JSON, not prose. `enum`
 * pins the categorical fields; `additionalProperties:false` keeps output minimal
 * (fewer tokens = fewer neurons).
 */
const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ACTIONS as unknown as string[] },
    mode: { type: "string", enum: MODES as unknown as string[] },
    risk: { type: "number" },
    reason: { type: "string" },
  },
  required: ["action", "mode", "risk", "reason"],
  additionalProperties: false,
} as const;

/**
 * Deterministic fallback used whenever the LLM call fails or returns junk. Pure
 * function of persona + situation -- no I/O, never throws -- so the race can always
 * make progress (SYSTEM_DESIGN SS9.1: the race must never break).
 *
 * Logic: default to the persona's mode and a "hold". A cautious driver (low risk)
 * yields when someone is closing fast in dense traffic; an aggressive driver commits
 * to a pass when there is a real gap and it is actively closing. Otherwise, hold.
 */
export function defaultDecision(persona: Persona, situation: Situation): Decision {
  const risk = persona.riskProfile;
  let action: Action = "hold";
  let reason = "fallback: hold lane and pace";

  const closingFast = situation.closingSpeedMps > 3; // ~7 mph of overtake speed
  const roomToPass = situation.gapAheadM > 25; // enough clear road ahead
  const busy = situation.trafficDensity > 0.6;

  if (risk >= 0.7 && closingFast && roomToPass) {
    // Aggressive persona with a real opportunity -> take the overtake.
    action = "pass";
    reason = "fallback: gap open and closing, commit to pass";
  } else if (risk < 0.5 && closingFast && busy) {
    // Cautious persona bearing down on traffic -> yield / back off.
    action = "yield";
    reason = "fallback: closing in traffic, yield for safety";
  } else if (situation.hovLanes > 0 && situation.lane !== 0 && risk >= 0.6) {
    // Assertive driver with an HOV lane available -> move over for clear air.
    action = "change_lane";
    reason = "fallback: shift toward HOV/clear lane";
  }

  return { action, mode: persona.defaultMode, risk, reason };
}

/** Compact, human-readable one-liner of the situation for the user message. */
function describeSituation(s: Situation): string {
  return (
    `segment=${s.segmentName} lane=${s.lane} hovLanes=${s.hovLanes} ` +
    `gapAheadM=${Math.round(s.gapAheadM)} closingSpeedMps=${s.closingSpeedMps.toFixed(1)} ` +
    `trafficDensity=${s.trafficDensity.toFixed(2)} speedLimitMph=${s.speedLimitMph}`
  );
}

/** Clamp a number to [0,1]; NaN/undefined -> fallback. */
function clamp01(n: unknown, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/**
 * Validate + coerce an arbitrary parsed value into a Decision. Returns null if the
 * required categorical fields are missing/invalid so the caller can fall back cleanly.
 */
function coerceDecision(raw: unknown, persona: Persona): Decision | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const action = r.action;
  const mode = r.mode;
  if (typeof action !== "string" || !ACTIONS.includes(action as Action)) return null;
  if (typeof mode !== "string" || !MODES.includes(mode as DriveMode)) return null;

  return {
    action: action as Action,
    mode: mode as DriveMode,
    risk: clamp01(r.risk, persona.riskProfile),
    reason:
      typeof r.reason === "string" && r.reason.trim().length > 0
        ? r.reason.trim().slice(0, 140)
        : "no reason given",
  };
}

/**
 * Make a tactical decision for one vehicle in one situation.
 *
 * @param env         Worker env (uses the AI binding only).
 * @param situation   The race situation at this segment/trigger.
 * @param specContext Injected RAG context STRING (from src/rag/, wired by the main
 *                    loop owner). Empty string is fine -- the agent just has less to go on.
 */
export async function decide(
  env: Env,
  situation: Situation,
  specContext: string,
): Promise<Decision> {
  const persona = getPersona(situation.vehicleId);

  // Persona baked in ONCE (system), retrieved spec context + live situation as user.
  // Keeping the spec context in its own labelled block lets the model use it without
  // us re-embedding or re-querying anything here (RAG already did that upstream).
  const contextBlock = specContext.trim().length > 0
    ? `Relevant spec/highway context:\n${specContext.trim()}\n\n`
    : "";

  const messages = [
    { role: "system", content: persona.systemPrompt },
    {
      role: "user",
      content:
        contextBlock +
        `Race situation:\n${describeSituation(situation)}\n\n` +
        "Make your single tactical decision now.",
    },
  ];

  try {
    // Native JSON-mode structured output on the Workers AI binding. `response_format`
    // with a json_schema is what LangChain's REST chat class cannot do -- hence env.AI.
    const out = await env.AI.run(DECISION_MODEL, {
      messages,
      max_tokens: MAX_TOKENS,
      response_format: {
        type: "json_schema",
        json_schema: DECISION_JSON_SCHEMA,
      },
    });

    // Text-generation output is { response?: string } -- the response is JSON text.
    const text = (out as { response?: string }).response;
    if (typeof text !== "string" || text.trim().length === 0) {
      return defaultDecision(persona, situation);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return defaultDecision(persona, situation);
    }

    return coerceDecision(parsed, persona) ?? defaultDecision(persona, situation);
  } catch {
    // Any binding/network/model error -> deterministic persona default. Never throw:
    // the race must keep moving (SYSTEM_DESIGN SS9.1).
    return defaultDecision(persona, situation);
  }
}

/**
 * HTTP handler for a future POST /agent-decide route. The main loop owner wires the
 * route in src/index.ts (which this agent must not edit); this exports the handler.
 *
 * Body: { situation: Situation, specContext?: string }
 * Returns: the Decision JSON. specContext defaults to "" (RAG wiring is the loop
 * owner's job -- see index.ts routing).
 */
export async function agentDecideHandler(request: Request, env: Env): Promise<Response> {
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { "content-type": "application/json" },
    });

  let body: { situation?: Situation; specContext?: string };
  try {
    body = (await request.json()) as { situation?: Situation; specContext?: string };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const situation = body.situation;
  if (!situation || typeof situation.vehicleId !== "string" || !situation.segmentName) {
    return json({ error: "body requires { situation: { vehicleId, segmentName, ... } }" }, 400);
  }

  const decision = await decide(env, situation, body.specContext ?? "");
  return json(decision);
}
