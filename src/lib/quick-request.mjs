// Phone-only quick request: validation and the payload sent to POST /api/leads.
// Name and ZIP are not collected; staff take them on the callback. The symptom selection sets the triage level.
import { triage, triageSummary, triageDetails } from "./triage.mjs";

export function phoneError(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "Enter your phone number.";
  const digits = value.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 11) return "Enter a 10 digit phone number, for example 214 555 0123.";
  return null;
}

// Returns null when the symptom is not one of the listed choices.
export function buildQuickBody({ phone, symptom, atRisk = false, unsafeTemp = false, website = "" }) {
  const t = triage({ symptom, atRisk, unsafeTemp });
  if (!t) return null;
  return {
    type: "B2C",
    channel: "form",
    serviceLine: t.serviceLine,
    phone: String(phone).trim(),
    emergency: t.emergency,
    details: { quick: true, description: `Callback request. ${triageSummary(t)} Name and ZIP not collected.`, ...triageDetails(t) },
    source: "website-quick",
    website,
  };
}
