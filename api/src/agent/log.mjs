// A4: the only writer of agent_actions_log. Ids and reason codes only; never message text or contact details.
export async function logAction(db, { at, conversationId = null, actionId = null, actor, event, data = {} }) {
  await db.query(
    `INSERT INTO agent_actions_log (at, conversation_id, action_id, actor_type, event, data)
     VALUES ($1::timestamptz, $2, $3, $4, $5, $6::jsonb)`,
    [at, conversationId, actionId, actor, event, JSON.stringify(data)]
  );
}
