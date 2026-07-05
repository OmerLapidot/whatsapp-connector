// Pure schedule time math: parse CLI flags into a spec, compute occurrences,
// and describe specs for previews. All times are machine-local.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function err(msg, code) { const e = new Error(msg); e.code = code; return e; }

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const hour = Number(m[1]), minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parseAbsolute(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
  // Date rolls over invalid days (Feb 30 -> Mar 2); reject those.
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}

function parseRelative(s) {
  const m = /^(\d+)([mhd])$/.exec(String(s || ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  return n * { m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

// args: {at?, in?, every?, on?} -> {type:'once', at} | {type:'recurring', every, on?, hour, minute}
function parseWhen(args, nowMs) {
  const { at, in: rel, every, on } = args || {};
  if (every != null) {
    if (rel != null) throw err('--in cannot be combined with --every', 'BAD_SCHEDULE');
    const hm = parseHM(at);
    if (!hm) throw err('--every requires --at HH:MM', 'BAD_SCHEDULE');
    const ev = String(every).toLowerCase();
    if (ev === 'month') {
      const day = Number(on);
      if (!Number.isInteger(day) || day < 1 || day > 31) throw err('--every month requires --on <1-31>', 'BAD_SCHEDULE');
      return { type: 'recurring', every: 'month', on: day, hour: hm.hour, minute: hm.minute };
    }
    if (on != null) throw err('--on is only valid with --every month', 'BAD_SCHEDULE');
    if (ev === 'day' || WEEKDAYS.includes(ev)) return { type: 'recurring', every: ev, hour: hm.hour, minute: hm.minute };
    throw err('unknown --every value "' + every + '" (use day, a weekday name, or month)', 'BAD_SCHEDULE');
  }
  if (rel != null) {
    if (at != null) throw err('use either --at or --in, not both', 'BAD_SCHEDULE');
    const ms = parseRelative(rel);
    if (ms == null) throw err('bad --in value "' + rel + '" (use e.g. 30m, 2h, 1d)', 'BAD_SCHEDULE');
    return { type: 'once', at: nowMs + ms };
  }
  if (at != null) {
    const abs = parseAbsolute(at);
    if (abs != null) {
      if (abs <= nowMs) throw err('scheduled time is in the past', 'PAST_SCHEDULE');
      return { type: 'once', at: abs };
    }
    const hm = parseHM(at);
    if (hm) {
      const d = new Date(nowMs);
      d.setHours(hm.hour, hm.minute, 0, 0);
      if (d.getTime() <= nowMs) { d.setDate(d.getDate() + 1); d.setHours(hm.hour, hm.minute, 0, 0); }
      return { type: 'once', at: d.getTime() };
    }
    throw err('bad --at value "' + at + '" (use HH:MM or "YYYY-MM-DD HH:MM")', 'BAD_SCHEDULE');
  }
  throw err('missing schedule: use --at or --in (plus --every for recurring)', 'BAD_SCHEDULE');
}

// Next occurrence strictly after fromMs; null for a one-shot already past
// OR any corrupt/hand-edited recurring spec (never-due, and never an infinite loop).
function nextFireAt(spec, fromMs) {
  if (spec.type === 'once') return spec.at > fromMs ? spec.at : null;
  const { hour, minute } = spec;
  // Corrupt store guard: bad time fields would make Date invalid and (for the weekly
  // loop below) spin forever. Treat as never-due.
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (spec.every === 'month') {
    if (!Number.isInteger(spec.on) || spec.on < 1 || spec.on > 31) return null;
    let y = new Date(fromMs).getFullYear(), mo = new Date(fromMs).getMonth();
    for (let i = 0; i < 14; i++) {
      const lastDay = new Date(y, mo + 1, 0).getDate();
      const c = new Date(y, mo, Math.min(spec.on, lastDay), hour, minute, 0, 0);
      if (c.getTime() > fromMs) return c.getTime();
      mo++; if (mo > 11) { mo = 0; y++; }
    }
    return null; // unreachable: 14 months always contains an occurrence
  }
  const target = spec.every === 'day' ? null : WEEKDAYS.indexOf(spec.every);
  if (target === -1) return null; // unrecognized spec (hand-edited store): never due, don't loop forever
  const d = new Date(fromMs);
  d.setHours(hour, minute, 0, 0);
  while ((target != null && d.getDay() !== target) || d.getTime() <= fromMs) {
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0); // re-assert wall time across DST shifts
  }
  return d.getTime();
}

function pad(n) { return String(n).padStart(2, '0'); }

function describe(spec) {
  if (spec.type === 'once') {
    const d = new Date(spec.at);
    return 'once at ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  const hm = pad(spec.hour) + ':' + pad(spec.minute);
  if (spec.every === 'month') return 'every month on day ' + spec.on + ' at ' + hm;
  return 'every ' + spec.every + ' at ' + hm;
}

module.exports = { parseWhen, nextFireAt, describe };
