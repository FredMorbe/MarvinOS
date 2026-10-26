// What the chat shows of a run, and when a sent message may still be edited.

/** event kinds the chat view shows; the first one of them means the agent has started to answer */
export const ANSWER_KINDS = new Set(['text', 'tool', 'tool_error']);

export const isAnswerEvent = e => ANSWER_KINDS.has(e.kind);

/** a message is editable until its run is over or has shown anything: queued or running, and no text/tool yet */
export const isEditable = (run, events) =>
  run.trigger === 'chat' && (run.status === 'queued' || run.status === 'running') && !events.some(isAnswerEvent);

/** the pinned ("priority") agents of the chat list, in order: a list of known agent ids without duplicates */
export function validatePins(ids, knownIds) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('ids must be a list of agent ids');
  const unknown = ids.filter(id => !knownIds.includes(id));
  if (unknown.length) throw new Error(`unknown agent: ${unknown.join(', ')}`);
  return [...new Set(ids)];
}
