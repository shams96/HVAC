// A12: retention. Deletes transcript text (rows stay, for counts and ids) and scrubs leftover action details.
export async function purgeChats(db, now = new Date(), { days = 30 } = {}) {
  if (!Number.isFinite(days) || days < 0) throw new Error("purgeChats: days must be a non-negative number");
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const msgs = await db.query(
    "UPDATE chat_messages SET content = NULL, purged_at = $1::timestamptz WHERE created_at < $2::timestamptz AND purged_at IS NULL RETURNING id",
    [nowIso, cutoff]
  );
  // Abandoned proposals (never confirmed, never rejected) stay 'pending' until someone happens to open that conversation
  // again, so they are closed here too: past retention nothing keeps contact details, whatever its status.
  const acts = await db.query(
    `UPDATE pending_actions
        SET args = '{}'::jsonb, summary = '[removed]',
            status = CASE WHEN status = 'pending' THEN 'expired' ELSE status END,
            resolved_at = CASE WHEN status = 'pending' THEN $2::timestamptz ELSE resolved_at END
      WHERE created_at < $1::timestamptz AND (args <> '{}'::jsonb OR summary <> '[removed]' OR status = 'pending') RETURNING id`,
    [cutoff, nowIso]
  );
  return { messages: msgs.rows.length, actions: acts.rows.length };
}
