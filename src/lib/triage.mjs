// Request triage. The visitor picks exactly what is happening; the answer sets a priority level for staff.
// Levels: safety (leave the building, call 911), urgent (same day priority), soon, routine.
// Checked 2026-11-24 against published practice: no single industry standard exists; gas, CO and fire first, vulnerable occupants escalated, running-but-failing and leaks same day or later.
// The 90F and 50F numbers have no published source (inferred). Heat has no fixed indoor cutoff in CDC material; NIA/FEMA cite 60 to 65F as a hypothermia risk for older adults only.
// DRAFT RULES pending owner and attorney approval: the symptom list, the risk questions and the temperature thresholds below.
// A level is a staff priority, never a promise of a response time.

export const UNSAFE_HEAT_F = 90;
export const UNSAFE_COLD_F = 50;

const SAFETY_911 = "Leave the building now and call 911. Stay outside until responders say it is safe. Do not wait for a callback. After you are safe, you can send this request.";

// group: label shown in the picker. level "down" means priority depends on the risk answers. asksRisk shows the two risk questions so staff see them; no cooling and no heating are always urgent (owner decision 2026-11-25).
export const SYMPTOMS = [
  { id: "gas-smell", group: "Safety problem", label: "I smell gas", serviceLine: "heating", level: "safety", alert: "Leave the building now. Call 911 or your gas utility's emergency number from outside. Do not wait for a callback. After you are safe, you can send this request." },
  { id: "co-alarm", group: "Safety problem", label: "Carbon monoxide alarm", serviceLine: "heating", level: "safety", alert: SAFETY_911 },
  { id: "smoke-sparks", group: "Safety problem", label: "Smoke, burning or sparks", serviceLine: "other", level: "safety", alert: SAFETY_911 },
  { id: "no-cooling", group: "System is not running", label: "No cooling (AC not working)", serviceLine: "cooling", level: "urgent", asksRisk: true },
  { id: "no-heating", group: "System is not running", label: "No heating", serviceLine: "heating", level: "urgent", asksRisk: true },
  { id: "commercial-cooling-failed", group: "System is not running", label: "Commercial cooling failed", serviceLine: "cooling", level: "urgent" },
  { id: "weak-cooling", group: "System is running poorly", label: "Cooling is weak", serviceLine: "cooling", level: "soon" },
  { id: "ice-on-unit", group: "System is running poorly", label: "Ice on the unit or coil", serviceLine: "cooling", level: "soon" },
  { id: "weak-heating", group: "System is running poorly", label: "Heating is weak", serviceLine: "heating", level: "soon" },
  { id: "water-leak", group: "System is running poorly", label: "Water leaking", serviceLine: "other", level: "soon" },
  { id: "noise-smell", group: "System is running poorly", label: "Unusual noise or smell", serviceLine: "other", level: "soon" },
  { id: "thermostat", group: "System is running poorly", label: "Thermostat blank or dead", serviceLine: "other", level: "soon" },
  { id: "breaker", group: "System is running poorly", label: "Breaker keeps tripping", serviceLine: "other", level: "soon" },
  { id: "maintenance", group: "Planned work", label: "Maintenance or tune up", serviceLine: "other", level: "routine" },
  { id: "estimate", group: "Planned work", label: "Estimate: replace or install", serviceLine: "other", level: "routine" },
  { id: "other", group: "Planned work", label: "Something else or not sure", serviceLine: "other", level: "routine" },
];

export const AT_RISK_LABEL = "Someone here is 65 or older, under 2, pregnant, or has a medical condition";
export const UNSAFE_TEMP_LABEL = `The temperature inside is dangerous (above ${UNSAFE_HEAT_F}°F or below ${UNSAFE_COLD_F}°F)`;

export const symptomById = (id) => SYMPTOMS.find((s) => s.id === id) ?? null;
export const needsRiskQuestions = (id) => Boolean(symptomById(id)?.asksRisk);

export function symptomError(id) {
  return symptomById(id) ? null : "Choose what is happening.";
}

// Returns null for an unknown symptom.
export function triage({ symptom, atRisk = false, unsafeTemp = false }) {
  const s = symptomById(symptom);
  if (!s) return null;
  const risk = s.asksRisk ? Boolean(atRisk) : false;
  const temp = s.asksRisk ? Boolean(unsafeTemp) : false;
  let level = s.level;
  if (s.level === "down") level = risk || temp ? "urgent" : "soon";
  return {
    level,
    emergency: level === "safety" || level === "urgent",
    serviceLine: s.serviceLine,
    symptom: s.id,
    symptomLabel: s.label,
    atRisk: risk,
    unsafeTemp: temp,
  };
}

// Plain sentence staff read first on the lead.
export function triageSummary(t) {
  const bits = [`Reported: ${t.symptomLabel}.`];
  if (t.atRisk) bits.push("Vulnerable person at the property.");
  if (t.unsafeTemp) bits.push("Customer reports a dangerous indoor temperature.");
  return bits.join(" ");
}

// The part sent to the lead API inside details.
export const triageDetails = (t) => ({ triage: { level: t.level, symptom: t.symptom, atRisk: t.atRisk, unsafeTemp: t.unsafeTemp } });
