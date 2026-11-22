export const CHANNELS = ["call", "sms", "email", "marketing"];

// records: [{ channel, status: 'granted'|'revoked' }] in chronological order. Latest per channel wins.
// No record means no consent (never assume).
export function canContact(records, channel) {
  let last = null;
  for (const r of records) if (r.channel === channel) last = r.status;
  return last === "granted";
}
