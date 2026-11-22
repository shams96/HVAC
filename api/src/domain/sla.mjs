// First-response SLA in calendar minutes (defaults; owner confirms; business-hours SLA waits on owner hours).
export const DEFAULT_SLA = { emergency: 15, call: 15, chat: 30, booking: 60, form: 60, b2b: 240 };

export function slaMinutes(type, channel, emergency, config = DEFAULT_SLA) {
  if (emergency) return config.emergency;
  if (type === "B2B") return config.b2b;
  const m = config[channel];
  if (!Number.isFinite(m)) throw new Error(`no SLA configured for channel "${channel}"`);
  return m;
}

export const slaDue = (createdAt, minutes) => new Date(createdAt.getTime() + minutes * 60_000);
