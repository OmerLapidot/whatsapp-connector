// Resolve a user-supplied chat reference (id or name) to one chat.
function resolveChat(chats, query) {
  const q = String(query).trim();

  const byId = chats.find((c) => c.id === q);
  if (byId) return { status: 'match', chat: byId };

  const lower = q.toLowerCase();
  const exact = chats.filter((c) => (c.name || '').toLowerCase() === lower);
  if (exact.length === 1) return { status: 'match', chat: exact[0] };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact };

  const partial = chats.filter((c) => (c.name || '').toLowerCase().includes(lower));
  if (partial.length === 1) return { status: 'match', chat: partial[0] };
  if (partial.length > 1) return { status: 'ambiguous', candidates: partial };

  return { status: 'notFound', query: q };
}

module.exports = { resolveChat };
