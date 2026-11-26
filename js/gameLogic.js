// Pure game rules: no DOM, no database.
export const EFFORT_TIERS = {
  small:      { label: 'Small task',            xp: 5 },
  standard:   { label: 'Standard task',         xp: 10 },
  meaningful: { label: 'Meaningful milestone',  xp: 25 },
  major:      { label: 'Major milestone',       xp: 50 },
};
export const QUEST_TYPES = { main: 'Main Quest', milestone: 'Milestone', daily: 'Daily', weekly: 'Weekly', side: 'Side Quest' };
export const RECURRING = new Set(['daily', 'weekly']);
export const MODES = ['normal', 'gentle', 'rest'];
export const DEFAULT_ATTRIBUTES = [
  { id: 'craft', name: 'Craft' }, { id: 'body', name: 'Body' },
  { id: 'mind', name: 'Mind' },   { id: 'order', name: 'Order' },
];

export function xpForTier(tier) {
  const t = EFFORT_TIERS[tier];
  if (!t) throw new Error(`Unknown effort tier: ${tier}`);
  return t.xp;
}

// Level 1 = 0 XP. Level N (N>=2) = sum of 50*k for k=2..N = 50 * (N(N+1)/2 - 1).
export function xpForLevel(n) { return n <= 1 ? 0 : 50 * ((n * (n + 1)) / 2 - 1); }

export function levelFromXp(xp) {
  let n = 1;
  while (xp >= xpForLevel(n + 1)) n++;
  return n;
}

export function levelProgress(xp) {
  const level = levelFromXp(xp), floor = xpForLevel(level), span = xpForLevel(level + 1) - floor;
  return { level, into: xp - floor, span, pct: Math.min(100, Math.round((100 * (xp - floor)) / span)) };
}

const pad = (n) => String(n).padStart(2, '0');

// Local calendar day, e.g. "2026-11-26".
export function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ISO week (Mon-start) from the LOCAL calendar date, e.g. "2026-W48".
export function localWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // Thursday of this week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad(week)}`;
}

export function periodKeyFor(type, date = new Date()) {
  if (type === 'daily') return localDayKey(date);
  if (type === 'weekly') return localWeekKey(date);
  return 'once';
}

// Stored as UTC ISO strings, shown in the user's local time zone.
export function formatLocal(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
