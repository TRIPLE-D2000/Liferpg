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

// ---- Modes (Phase 2) -------------------------------------------------------
export const EFFORT_ORDER = ['small', 'standard', 'meaningful', 'major'];

// Pure view logic: which active quests to show, in what order, and which are collapsed.
// Rest mode hides the board unless showAnyway. Nothing here ever blocks saving progress.
export function prepareBoard(quests, mode, { filter = 'all', showAnyway = false, expanded = new Set() } = {}) {
  const typeOrder = Object.keys(QUEST_TYPES);
  const base = (a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type) || a.createdAt.localeCompare(b.createdAt);
  const list = quests.filter((q) => q.status === 'active' && (filter === 'all' || q.type === filter));
  if (mode === 'gentle') list.sort((a, b) => EFFORT_ORDER.indexOf(a.effortTier) - EFFORT_ORDER.indexOf(b.effortTier) || base(a, b));
  else list.sort(base);
  if (mode === 'rest' && !showAnyway) return { resting: true, items: [] };
  const heavy = (q) => q.effortTier === 'meaningful' || q.effortTier === 'major';
  return { resting: mode === 'rest', items: list.map((q) => ({ quest: q, collapsed: mode === 'gentle' && heavy(q) && !expanded.has(q.id) })) };
}

// ---- Weekly consistency (Phase 2) -----------------------------------------
// The 7 local day keys of the week containing `now` (Monday start by default).
export function weekDays(now = new Date(), weekStartsOn = 1) {
  const off = (now.getDay() - weekStartsOn + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - off + i)));
}

// Derived purely from completion history. Unique local days with >= 1 completion. Never penalizes.
export function weeklyConsistency(completions, now = new Date(), target = 4, weekStartsOn = 1) {
  const active = new Set(completions.map((c) => localDayKey(new Date(c.completedAt))));
  const today = localDayKey(now);
  const days = weekDays(now, weekStartsOn).map((key) => ({ key, active: active.has(key), today: key === today }));
  const count = days.filter((d) => d.active).length;
  const reached = count >= target;
  const message = reached ? 'Target reached. Anything more is a bonus.'
    : count === 0 ? 'A fresh week. One quest is enough to get started.'
    : 'Good progress. Every active day counts.';
  return { count, target, days, reached, message, pct: Math.min(100, Math.round((100 * count) / target)) };
}

// ---- Gold (Phase 3) ---------------------------------------------------------
export const GOLD_BY_TIER = { small: 5, standard: 10, meaningful: 25, major: 50 };
export function goldForTier(tier) {
  const g = GOLD_BY_TIER[tier];
  if (g === undefined) throw new Error(`Unknown effort tier: ${tier}`);
  return g;
}
// Gold only for Gold-eligible quests completed outside Rest mode. XP is never affected by this.
export function goldAwardFor(quest, mode) {
  return quest.isGoldEligible === false || mode === 'rest' ? 0 : goldForTier(quest.effortTier);
}
// The balance is never stored: it is always the sum of the immutable ledger.
export const goldBalance = (ledger) => ledger.reduce((n, l) => n + l.amount, 0);

// ---- Rewards (Phase 3) -------------------------------------------------------
export const MAX_REWARD_COST = 100000;

// Returns trimmed, valid reward fields or throws a user-readable Error.
export function validateReward({ title, description = '', goldCost }) {
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t) throw new Error('Reward title is required.');
  if (t.length > 80) throw new Error('Reward title must be 80 characters or fewer.');
  const d = typeof description === 'string' ? description.trim() : '';
  if (d.length > 300) throw new Error('Description must be 300 characters or fewer.');
  if (typeof goldCost !== 'number' || !Number.isInteger(goldCost)) throw new Error('Gold cost must be a whole number.');
  if (goldCost < 1) throw new Error('Gold cost must be at least 1.');
  if (goldCost > MAX_REWARD_COST) throw new Error(`Gold cost cannot be more than ${MAX_REWARD_COST}.`);
  return { title: t, description: d, goldCost };
}

// One chronological list of every Gold movement, newest first. Titles come from snapshots,
// so history reads correctly even after a quest is deleted or a reward is renamed.
export function buildHistory({ currencyLedger, completions, redemptions }) {
  const comp = new Map(completions.map((c) => [c.id, c]));
  const red = new Map(redemptions.map((r) => [r.id, r]));
  return [...currencyLedger].map((l) => {
    const c = l.relatedCompletionId && comp.get(l.relatedCompletionId);
    const r = l.relatedRedemptionId && red.get(l.relatedRedemptionId);
    if (c) return { id: l.id, kind: 'earned', amount: l.amount, title: c.questTitleSnapshot, createdAt: l.createdAt };
    if (r) return { id: l.id, kind: l.amount < 0 ? 'spent' : 'refund', amount: l.amount, title: r.rewardTitleSnapshot, createdAt: l.createdAt, redemptionId: r.id, status: r.status };
    return { id: l.id, kind: 'adjustment', amount: l.amount, title: l.reason, createdAt: l.createdAt };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.amount - a.amount);
}
