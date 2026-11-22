// Consent wording shown next to the chat confirmation checkboxes. OWNER/ATTORNEY SUPPLIED; null until approved.
// While null, production chat shows no consent checkboxes and records no consent. Bump `version` on every wording change:
// the version is stored with each consent record as proof of what the person saw.
export interface ConsentWording { version: string; sms: string; email: string }
export const consentWording: ConsentWording | null = null;
