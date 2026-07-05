const path = require('path');

// Turn `wa <verb> ...argv` into an RPC payload {cmd, args} or null (bad usage).
function parseArgs(argv) {
  const a = argv.slice();
  const verb = a.shift();
  if (!verb) return null;

  const flags = {};
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--limit') flags.limit = parseInt(a[++i], 10);
    else if (a[i] === '--chat') flags.chat = a[++i];
    else if (a[i] === '--at') flags.at = a[++i];
    else if (a[i] === '--in') flags.in = a[++i];
    else if (a[i] === '--every') flags.every = a[++i];
    else if (a[i] === '--on') flags.on = parseInt(a[++i], 10);
    else if (a[i] === '--media') flags.media = a[++i];
    else if (a[i] === '--caption') flags.caption = a[++i];
    else if (a[i] === '--all') flags.all = true;
    else pos.push(a[i]);
  }
  const withLimit = (o) => (Number.isInteger(flags.limit) ? { ...o, limit: flags.limit } : o);

  switch (verb) {
    case 'status':
    case 'ping': return { cmd: 'status', args: {} };
    case 'chats': return { cmd: 'chats', args: {} };
    case 'read': {
      if (!pos[0]) return null;
      const args = withLimit({ chat: pos[0] });
      if (flags.all) args.all = true;   // --all → read the whole chat (bypasses MAX_LIMIT)
      return { cmd: 'read', args };
    }
    case 'search': return pos[0] ? { cmd: 'search', args: withLimit(flags.chat ? { query: pos[0], chat: flags.chat } : { query: pos[0] }) } : null;
    case 'members': return pos[0] ? { cmd: 'members', args: { group: pos[0] } } : null;
    case 'contacts': return pos[0] ? { cmd: 'contacts', args: { query: pos[0] } } : null;
    case 'media': return pos.length >= 2 ? { cmd: 'media', args: { chat: pos[0], messageId: pos[1] } } : null;
    case 'send': return pos.length >= 2 ? { cmd: 'send', args: { chat: pos[0], text: pos.slice(1).join(' ') } } : null;
    case 'send-confirm': return pos[0] ? { cmd: 'sendConfirm', args: { token: pos[0] } } : null;
    case 'send-media': return pos.length >= 2 ? { cmd: 'sendMedia', args: { chat: pos[0], path: pos[1], caption: pos.slice(2).join(' ') } } : null;
    case 'react': return pos.length >= 3 ? { cmd: 'react', args: { chat: pos[0], messageId: pos[1], emoji: pos[2] } } : null;
    case 'mark-read': return pos[0] ? { cmd: 'markRead', args: { chat: pos[0] } } : null;
    case 'allow': {
      // `all` shadows chat names (like `schedule list`): a chat literally
      // named "all" is managed by its exact id.
      if (pos[0] === 'list') return { cmd: 'allowList', args: {} };
      if (pos[0] === 'all') return { cmd: 'allowAll', args: {} };
      if (pos[0] === 'add') return pos.length > 1 ? { cmd: 'allowAdd', args: { chats: pos.slice(1) } } : null;
      if (pos[0] === 'remove') {
        if (pos.length === 2 && pos[1] === 'all') return { cmd: 'allowRemoveAll', args: {} };
        return pos.length > 1 ? { cmd: 'allowRemove', args: { chats: pos.slice(1) } } : null;
      }
      return null;
    }
    case 'schedule': {
      // subcommands shadow chat names: a chat literally named "list"/"cancel"
      // must be scheduled by its chat id instead.
      if (pos[0] === 'list') return { cmd: 'scheduleList', args: flags.all ? { all: true } : {} };
      if (pos[0] === 'cancel') return pos[1] ? { cmd: 'scheduleCancel', args: { id: pos[1] } } : null;
      if (!pos[0]) return null;
      const text = pos.slice(1).join(' ');
      if (!flags.at && !flags.in) return null;   // needs a when
      if (!text && !flags.media) return null;    // needs content
      const args = { chat: pos[0] };
      if (text) args.text = text;
      for (const k of ['at', 'in', 'every', 'on', 'caption']) {
        if (flags[k] !== undefined) args[k] = flags[k];
      }
      // Resolve --media here, in the user's shell cwd; the daemon's cwd (launchd) is unrelated,
      // so a relative path would otherwise be existence-checked against the wrong directory.
      if (flags.media !== undefined) args.media = path.resolve(flags.media);
      return { cmd: 'schedule', args };
    }
    case 'schedule-confirm': return pos[0] ? { cmd: 'scheduleConfirm', args: { token: pos[0] } } : null;
    default: return null;
  }
}

module.exports = { parseArgs };
