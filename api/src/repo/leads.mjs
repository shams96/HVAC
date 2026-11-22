import { normalizePhone, normalizeEmail } from "../domain/phone.mjs";
import { canTransition, initialStage, isTerminal } from "../domain/stages.mjs";
import { slaMinutes, slaDue, DEFAULT_SLA } from "../domain/sla.mjs";
import { pickRoute } from "../domain/routing.mjs";
import { CHANNELS, canContact } from "../domain/consent.mjs";

export class PipelineError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ACTOR_TYPES = ["user", "system", "agent", "webhook", "customer"];
const iso = (d) => d.toISOString();

async function addEvent(tx, leadId, nowIso, { actorType, actorId, type, from = null, to = null, data = {} }) {
  const r = await tx.query(
    `INSERT INTO lead_events (lead_id, at, actor_type, actor_id, event_type, from_stage, to_stage, data)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
    [leadId, nowIso, actorType, actorId, type, from, to, JSON.stringify(data)]
  );
  return r.rows[0].id;
}

async function enqueue(tx, leadId, eventId, type, nowIso) {
  await tx.query(
    `INSERT INTO crm_outbox (lead_id, event_id, event_type, next_attempt_at) VALUES ($1, $2, $3, $4::timestamptz)`,
    [leadId, eventId, type, nowIso]
  );
}

export async function createLead(db, input, opts = {}) {
  const now = opts.now ?? new Date();
  const nowIso = iso(now);
  const slaCfg = opts.sla ?? DEFAULT_SLA;
  const windowDays = opts.dedupeWindowDays ?? 14;

  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (!phone && !email) throw new PipelineError("contact_required", "A valid phone number or email is required");
  if (input.type === "B2B" && !input.b2b?.company?.trim()) throw new PipelineError("company_required", "B2B leads need a company name");
  for (const c of input.consents ?? []) {
    if (!CHANNELS.includes(c.channel)) throw new PipelineError("bad_consent_channel", `Unknown consent channel "${c.channel}"`);
  }

  return db.transaction(async (tx) => {
    // --- contact resolution (dedupe by phone or email) ---
    const byPhone = phone ? (await tx.query("SELECT * FROM contacts WHERE phone_e164 = $1", [phone])).rows[0] : undefined;
    const byEmail = email ? (await tx.query("SELECT * FROM contacts WHERE email = $1", [email])).rows[0] : undefined;
    let contact = byPhone ?? byEmail;
    let review = null;
    if (byPhone && byEmail && byPhone.id !== byEmail.id) review = { candidate_contact_ids: [byPhone.id, byEmail.id] }; // never auto-merge

    if (!contact) {
      contact = (
        await tx.query(`INSERT INTO contacts (name, phone_e164, email, created_at) VALUES ($1, $2, $3, $4::timestamptz) RETURNING *`, [
          input.name ?? null, phone, email, nowIso,
        ])
      ).rows[0];
    } else {
      const fillPhone = !review && phone && !contact.phone_e164 && !byPhone ? phone : null;
      const fillEmail = !review && email && !contact.email && !byEmail ? email : null;
      await tx.query(
        `UPDATE contacts SET name = COALESCE(name, $2), phone_e164 = COALESCE(phone_e164, $3), email = COALESCE(email, $4) WHERE id = $1`,
        [contact.id, input.name ?? null, fillPhone, fillEmail]
      );
    }

    // --- B2B account, sites, contact role ---
    let accountId = null;
    if (input.type === "B2B") {
      const b = input.b2b;
      const kind = b.kind ?? "commercial";
      const existing = await tx.query("SELECT id FROM accounts WHERE lower(name) = lower($1) AND kind = $2", [b.company.trim(), kind]);
      accountId =
        existing.rows[0]?.id ??
        (await tx.query("INSERT INTO accounts (name, kind, created_at) VALUES ($1, $2, $3::timestamptz) RETURNING id", [b.company.trim(), kind, nowIso])).rows[0].id;
      for (const s of b.sites ?? []) {
        const dup = await tx.query("SELECT 1 FROM sites WHERE account_id = $1 AND lower(label) = lower($2)", [accountId, s.label]);
        if (!dup.rows.length) {
          await tx.query("INSERT INTO sites (account_id, label, street_address, zip, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)", [
            accountId, s.label, s.streetAddress ?? null, s.zip ?? null, nowIso,
          ]);
        }
      }
      await tx.query("UPDATE contacts SET account_id = $2, role = COALESCE($3, role) WHERE id = $1", [contact.id, accountId, b.role ?? null]);
    }

    // --- consent: only what the person explicitly granted on this submission ---
    for (const c of input.consents ?? []) {
      await tx.query(
        `INSERT INTO consent_records (contact_id, channel, status, wording_version, source, captured_at)
         VALUES ($1, $2, 'granted', $3, $4, $5::timestamptz)`,
        [contact.id, c.channel, c.wordingVersion ?? null, `intake:${input.channel}`, nowIso]
      );
    }

    const emergency = input.emergency === true;
    const minutes = slaMinutes(input.type, input.channel, emergency, slaCfg);
    const due = iso(slaDue(now, minutes));
    const actor = { actorType: "customer", actorId: `intake:${input.channel}` };

    // --- attach to an existing open lead (same contact + service line) instead of duplicating ---
    const open = await tx.query(
      `SELECT id, emergency FROM leads
       WHERE contact_id = $1 AND service_line = $2 AND stage NOT IN ('won', 'lost')
         AND created_at > $3::timestamptz - make_interval(days => $4::int)
       ORDER BY id DESC LIMIT 1`,
      [contact.id, input.serviceLine, nowIso, windowDays]
    );
    if (open.rows[0]) {
      const lead = open.rows[0];
      const evId = await addEvent(tx, lead.id, nowIso, { ...actor, type: "inquiry_attached", data: { channel: input.channel, emergency } });
      await enqueue(tx, lead.id, evId, "inquiry_attached", nowIso);
      if (emergency && !lead.emergency) {
        await tx.query("UPDATE leads SET emergency = true, sla_due_at = LEAST(sla_due_at, $2::timestamptz), updated_at = $3::timestamptz WHERE id = $1", [lead.id, due, nowIso]);
        const e2 = await addEvent(tx, lead.id, nowIso, { ...actor, type: "escalated_emergency" });
        await enqueue(tx, lead.id, e2, "escalated_emergency", nowIso);
      }
      return { id: Number(lead.id), deduped: true };
    }

    // --- route ---
    const rules = input.zip ? (await tx.query("SELECT * FROM routing_rules WHERE zip = $1", [input.zip])).rows : [];
    const route = pickRoute(rules, input.zip, input.serviceLine);

    const stage = initialStage(input.type);
    const lead = (
      await tx.query(
        `INSERT INTO leads (type, channel, contact_id, account_id, zip, service_line, stage, emergency, branch_id, assignee_group,
                            routed_by, sla_due_at, details, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::jsonb, $14, $15::timestamptz, $15::timestamptz)
         RETURNING id`,
        [
          input.type, input.channel, contact.id, accountId, input.zip ?? null, input.serviceLine, stage, emergency,
          route.branchId, route.assigneeGroup, route.routedBy, due, JSON.stringify(input.details ?? {}), input.source ?? null, nowIso,
        ]
      )
    ).rows[0];
    const evId = await addEvent(tx, lead.id, nowIso, {
      ...actor, type: "lead_created", to: stage,
      data: { channel: input.channel, routed_by: route.routedBy, branch_id: route.branchId, sla_minutes: minutes, emergency },
    });
    await enqueue(tx, lead.id, evId, "lead_created", nowIso);
    if (review) {
      const rid = await addEvent(tx, lead.id, nowIso, { actorType: "system", actorId: "dedupe", type: "needs_review", data: review });
      await enqueue(tx, lead.id, rid, "needs_review", nowIso);
    }
    return { id: Number(lead.id), deduped: false, stage, branchId: route.branchId, routedBy: route.routedBy, slaDueAt: due, contactId: Number(contact.id) };
  });
}

export async function transitionLead(db, leadId, to, actor, { reason, now = new Date() } = {}) {
  if (!ACTOR_TYPES.includes(actor?.type) || !actor?.id?.trim()) throw new PipelineError("actor_required", "A valid actor type and id are required");
  const nowIso = iso(now);
  return db.transaction(async (tx) => {
    const lead = (await tx.query("SELECT * FROM leads WHERE id = $1 FOR UPDATE", [leadId])).rows[0];
    if (!lead) throw new PipelineError("not_found", "Lead not found", 404);
    if (!canTransition(lead.type, lead.stage, to)) {
      throw new PipelineError("invalid_transition", `Cannot move a ${lead.type} lead from ${lead.stage} to ${to}`, 409);
    }
    if (to === "lost" && !reason?.trim()) throw new PipelineError("reason_required", "A reason is required when marking a lead lost");
    await tx.query(
      `UPDATE leads SET stage = $2, lost_reason = $3, updated_at = $4::timestamptz,
              closed_at = CASE WHEN $5::boolean THEN $4::timestamptz ELSE NULL END WHERE id = $1`,
      [leadId, to, to === "lost" ? reason.trim() : null, nowIso, isTerminal(to)]
    );
    // The reason text lives on the (scrubbable) lead row, not in the immutable event.
    const evId = await addEvent(tx, leadId, nowIso, { actorType: actor.type, actorId: actor.id, type: "stage_changed", from: lead.stage, to, data: { reason_recorded: to === "lost" } });
    await enqueue(tx, leadId, evId, "stage_changed", nowIso);
    return { id: Number(leadId), from: lead.stage, to };
  });
}

// A lead that is still in its first stage after sla_due_at has breached its first-response SLA. Idempotent.
export async function sweepSlaBreaches(db, now = new Date()) {
  const nowIso = iso(now);
  return db.transaction(async (tx) => {
    const r = await tx.query(
      `UPDATE leads SET sla_breached_at = $1::timestamptz
       WHERE sla_breached_at IS NULL AND sla_due_at < $1::timestamptz AND stage IN ('new', 'lead') RETURNING id`,
      [nowIso]
    );
    for (const row of r.rows) {
      const evId = await addEvent(tx, row.id, nowIso, { actorType: "system", actorId: "sla-sweeper", type: "sla_breached" });
      await enqueue(tx, row.id, evId, "sla_breached", nowIso);
    }
    return r.rows.map((x) => Number(x.id));
  });
}

export async function optOut(db, { phone, email, channel }, now = new Date()) {
  const p = normalizePhone(phone);
  const e = normalizeEmail(email);
  if (!p && !e) throw new PipelineError("contact_required", "A valid phone number or email is required");
  const channels = channel === "all" ? CHANNELS : [channel];
  if (!channels.every((c) => CHANNELS.includes(c))) throw new PipelineError("bad_consent_channel", "Unknown channel");
  const nowIso = iso(now);
  return db.transaction(async (tx) => {
    const found = [];
    if (p) found.push(...(await tx.query("SELECT id FROM contacts WHERE phone_e164 = $1", [p])).rows);
    if (e) found.push(...(await tx.query("SELECT id FROM contacts WHERE email = $1", [e])).rows);
    let ids = [...new Set(found.map((r) => String(r.id)))];
    if (!ids.length) {
      // Unknown person: still record the suppression so a later inquiry cannot be contacted by mistake.
      const c = await tx.query("INSERT INTO contacts (phone_e164, email, created_at) VALUES ($1, $2, $3::timestamptz) RETURNING id", [p, e, nowIso]);
      ids = [String(c.rows[0].id)];
    }
    for (const id of ids) {
      for (const ch of channels) {
        await tx.query(
          `INSERT INTO consent_records (contact_id, channel, status, source, captured_at) VALUES ($1, $2, 'revoked', 'opt-out', $3::timestamptz)`,
          [id, ch, nowIso]
        );
      }
    }
    return ids.map(Number);
  });
}

export async function contactAllowed(db, contactId, channel) {
  const r = await db.query("SELECT channel, status FROM consent_records WHERE contact_id = $1 ORDER BY id", [contactId]);
  return canContact(r.rows, channel);
}

export async function getLead(db, leadId) {
  const lead = (await db.query("SELECT * FROM leads WHERE id = $1", [leadId])).rows[0];
  if (!lead) throw new PipelineError("not_found", "Lead not found", 404);
  const contact = (await db.query("SELECT id, name, phone_e164, email, role, account_id, anonymized_at FROM contacts WHERE id = $1", [lead.contact_id])).rows[0];
  const events = (await db.query("SELECT id, at, actor_type, actor_id, event_type, from_stage, to_stage, data FROM lead_events WHERE lead_id = $1 ORDER BY id", [leadId])).rows;
  return { lead, contact, events };
}

async function requireAccount(db, accountId) {
  const r = await db.query("SELECT id FROM accounts WHERE id = $1", [accountId]);
  if (!r.rows.length) throw new PipelineError("not_found", "Account not found", 404);
}

export async function addSite(db, accountId, s, now = new Date()) {
  await requireAccount(db, accountId);
  const r = await db.query(
    "INSERT INTO sites (account_id, label, street_address, zip, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz) RETURNING id",
    [accountId, s.label, s.streetAddress ?? null, s.zip ?? null, iso(now)]
  );
  return Number(r.rows[0].id);
}

export async function addAgreement(db, accountId, a, now = new Date()) {
  await requireAccount(db, accountId);
  const r = await db.query(
    "INSERT INTO agreements (account_id, site_id, kind, starts_on, ends_on, created_at) VALUES ($1, $2, $3, $4::date, $5::date, $6::timestamptz) RETURNING id",
    [accountId, a.siteId ?? null, a.kind, a.startsOn, a.endsOn ?? null, iso(now)]
  );
  return Number(r.rows[0].id);
}

// Retention: contacts whose leads are ALL lost and closed more than `months` ago lose their PII.
// Contacts with any revoked consent are kept (the suppression record must survive to keep honoring the opt-out).
export async function anonymizeExpired(db, now = new Date(), { months = 24 } = {}) {
  const nowIso = iso(now);
  return db.transaction(async (tx) => {
    const eligible = await tx.query(
      `SELECT c.id FROM contacts c JOIN leads l ON l.contact_id = c.id
       WHERE c.anonymized_at IS NULL
       GROUP BY c.id
       HAVING bool_and(l.stage = 'lost') AND max(l.closed_at) < $1::timestamptz - make_interval(months => $2::int)
          AND NOT EXISTS (SELECT 1 FROM consent_records r WHERE r.contact_id = c.id AND r.status = 'revoked')`,
      [nowIso, months]
    );
    const ids = JSON.stringify(eligible.rows.map((r) => String(r.id)));
    if (!eligible.rows.length) return 0;
    await tx.query(
      `UPDATE leads SET details = '{}'::jsonb, source = NULL, lost_reason = '[redacted]'
       WHERE contact_id IN (SELECT jsonb_array_elements_text($1::jsonb)::bigint)`,
      [ids]
    );
    await tx.query(
      `UPDATE contacts SET name = NULL, phone_e164 = NULL, email = NULL, role = NULL, anonymized_at = $2::timestamptz
       WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::bigint)`,
      [ids, nowIso]
    );
    return eligible.rows.length;
  });
}
