import { createHmac } from "node:crypto";
import { CHANNELS, canContact } from "../domain/consent.mjs";

// Single-worker drain. The Idempotency-Key header lets the CRM discard a duplicate if two workers ever overlap.
// PII is joined in at send time (never stored in the outbox), so anonymized contacts send no PII.
export async function buildPayload(db, row) {
  const ev = (await db.query("SELECT * FROM lead_events WHERE id = $1", [row.event_id])).rows[0];
  const lead = (await db.query("SELECT * FROM leads WHERE id = $1", [row.lead_id])).rows[0];
  const contact = (await db.query("SELECT * FROM contacts WHERE id = $1", [lead.contact_id])).rows[0];
  const account = lead.account_id ? (await db.query("SELECT name, kind FROM accounts WHERE id = $1", [lead.account_id])).rows[0] : null;
  const consentRows = (await db.query("SELECT channel, status FROM consent_records WHERE contact_id = $1 ORDER BY id", [contact.id])).rows;
  return {
    id: String(row.id),
    event: { id: String(ev.id), type: ev.event_type, at: new Date(ev.at).toISOString(), actor_type: ev.actor_type, actor_id: ev.actor_id, from_stage: ev.from_stage, to_stage: ev.to_stage },
    lead: {
      id: String(lead.id), type: lead.type, channel: lead.channel, stage: lead.stage, zip: lead.zip, service_line: lead.service_line,
      emergency: lead.emergency, branch_id: lead.branch_id, routed_by: lead.routed_by, sla_due_at: new Date(lead.sla_due_at).toISOString(),
      created_at: new Date(lead.created_at).toISOString(),
    },
    contact: { id: String(contact.id), name: contact.name, phone: contact.phone_e164, email: contact.email, role: contact.role },
    account,
    consent: Object.fromEntries(CHANNELS.map((c) => [c, canContact(consentRows, c)])),
  };
}

export const sign = (secret, body) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export async function drainOutbox(db, { url, secret, fetchImpl = fetch, now = new Date(), batch = 20, maxAttempts = 8, allowInsecure = false }) {
  const u = new URL(url);
  if (u.protocol !== "https:" && !allowInsecure) throw new Error("CRM webhook URL must be https");
  if (!secret || secret.length < 16) throw new Error("CRM webhook secret must be at least 16 characters");
  const nowIso = now.toISOString();
  const due = (await db.query(
    "SELECT * FROM crm_outbox WHERE status = 'pending' AND next_attempt_at <= $1::timestamptz ORDER BY id LIMIT $2",
    [nowIso, batch]
  )).rows;
  const result = { sent: 0, retried: 0, failed: 0 };
  for (const row of due) {
    let error = null;
    try {
      const body = JSON.stringify(await buildPayload(db, row));
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Signature": sign(secret, body), "X-Event-Id": String(row.id), "Idempotency-Key": String(row.id) },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    if (!error) {
      await db.query("UPDATE crm_outbox SET status = 'sent', sent_at = $2::timestamptz, attempts = attempts + 1, last_error = NULL WHERE id = $1", [row.id, nowIso]);
      result.sent++;
    } else if (row.attempts + 1 >= maxAttempts) {
      await db.query("UPDATE crm_outbox SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1", [row.id, error]);
      result.failed++;
    } else {
      const backoffMin = Math.min(2 ** (row.attempts + 1), 60);
      await db.query(
        "UPDATE crm_outbox SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3::timestamptz + make_interval(mins => $4::int) WHERE id = $1",
        [row.id, error, nowIso, backoffMin]
      );
      result.retried++;
    }
  }
  return result;
}
