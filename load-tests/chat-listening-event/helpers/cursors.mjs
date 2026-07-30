export function compareTuple(leftTime, leftId, rightTime, rightId) {
  const leftMillis = Date.parse(leftTime);
  const rightMillis = Date.parse(rightTime);
  if (Number.isFinite(leftMillis) && Number.isFinite(rightMillis)) {
    if (leftMillis > rightMillis) return 1;
    if (leftMillis < rightMillis) return -1;
  } else {
    if (leftTime > rightTime) return 1;
    if (leftTime < rightTime) return -1;
  }
  if (leftId > rightId) return 1;
  if (leftId < rightId) return -1;
  return 0;
}

export function assertNoPreJoinMessages(messages, joinedAt) {
  return messages.every(message => (
    message.visibility_scope === "own"
    || !message.published_at
    || message.published_at >= joinedAt
  ));
}

export function mergeById(current, incoming) {
  const byId = new Map();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, { ...byId.get(message.id), ...message });
  return Array.from(byId.values()).sort((left, right) => {
    const leftTime = left.published_at || left.created_at || "";
    const rightTime = right.published_at || right.created_at || "";
    const byTuple = compareTuple(leftTime, left.id, rightTime, right.id);
    return byTuple;
  });
}

export function advanceCursors(state, messages, participantId, joinedAt) {
  for (const message of messages) {
    if (message.visibility_scope === "public_new" && message.published_at && message.published_at >= joinedAt) {
      if (!state.publicCursor || compareTuple(message.published_at, message.id, state.publicCursor.publishedAt, state.publicCursor.id) > 0) {
        state.publicCursor = { publishedAt: message.published_at, id: message.id };
      }
    }
    if (message.visibility_scope === "public_update" && message.updated_at) {
      if (!state.publicUpdateCursor || compareTuple(message.updated_at, message.id, state.publicUpdateCursor.updatedAt, state.publicUpdateCursor.id) > 0) {
        state.publicUpdateCursor = { updatedAt: message.updated_at, id: message.id };
      }
    }
    if ((message.visibility_scope === "own" || message.participant_id === participantId) && message.updated_at) {
      if (!state.privateCursor || compareTuple(message.updated_at, message.id, state.privateCursor.updatedAt, state.privateCursor.id) > 0) {
        state.privateCursor = { updatedAt: message.updated_at, id: message.id };
      }
    }
  }
  return state;
}

