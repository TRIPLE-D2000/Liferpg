// IndexedDB wrapper: schema, seeding, atomic completion, backup/restore.
import { EFFORT_TIERS, QUEST_TYPES, MODES, DEFAULT_ATTRIBUTES, RECURRING, periodKeyFor, xpForTier, goldAwardFor, goldBalance, validateReward } from './gameLogic.js';

export const DB_NAME = 'life_rpg';
export const DB_VERSION = 3;
export const EXPORT_FORMAT_VERSION = 1;
const STORES = ['profile', 'attributes', 'quests', 'completions', 'currencyLedger', 'rewards', 'redemptions'];

export class DuplicateCompletionError extends Error {
  constructor() { super('Already completed for this period.'); this.name = 'DuplicateCompletionError'; }
}
export class InsufficientGoldError extends Error {
  constructor(have, need) { super(`Not enough Gold: you have ${have}, this costs ${need}.`); this.name = 'InsufficientGoldError'; }
}
export class DuplicateRedemptionError extends Error {
  constructor() { super('This redemption was already processed.'); this.name = 'DuplicateRedemptionError'; }
}
export class AlreadyRefundedError extends Error {
  constructor() { super('This redemption has already been refunded.'); this.name = 'AlreadyRefundedError'; }
}
export class BackupValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'BackupValidationError'; }
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = (tx) => new Promise((res, rej) => {
  tx.oncomplete = () => res();
  tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
});
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export function openDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result, tx = req.transaction, old = e.oldVersion;
      // Backfill helper: rewrites existing rows in place; never clears or recreates a store.
      const backfill = (store, fn) => {
        const cur = tx.objectStore(store).openCursor();
        cur.onsuccess = () => { const c = cur.result; if (!c) return; const v = fn(c.value); if (v) c.update(v); c.continue(); };
      };
      if (old < 1) { // Phase 1 schema
        db.createObjectStore('profile', { keyPath: 'id' });
        db.createObjectStore('attributes', { keyPath: 'id' });
        db.createObjectStore('quests', { keyPath: 'id' });
        const c = db.createObjectStore('completions', { keyPath: 'id' });
        c.createIndex('byQuestPeriod', ['questId', 'periodKey'], { unique: true });
        c.createIndex('byCompletedAt', 'completedAt');
      }
      if (old < 3) { // Phase 3: Gold ledger, rewards, redemptions
        const l = db.createObjectStore('currencyLedger', { keyPath: 'id' });
        l.createIndex('byTransactionKey', 'transactionKey', { unique: true });
        l.createIndex('byCompletion', 'relatedCompletionId');
        l.createIndex('byRedemption', 'relatedRedemptionId');
        l.createIndex('byCreatedAt', 'createdAt');
        const r = db.createObjectStore('rewards', { keyPath: 'id' });
        r.createIndex('byCreatedAt', 'createdAt');
        const d = db.createObjectStore('redemptions', { keyPath: 'id' });
        d.createIndex('byRewardId', 'rewardId');
        d.createIndex('byRedeemedAt', 'redeemedAt');
      }
      // Backfill existing rows ONCE per store (two cursors on one store would overwrite each other).
      // Old completions are never touched, so no retroactive Gold is created.
      if (old >= 1 && old < 3) {
        backfill('profile', (p) => (p.weeklyTargetDays === undefined ? { ...p, weeklyTargetDays: 4 } : null));
        backfill('quests', (q) => {
          const n = { ...q };
          if (n.updatedAt === undefined) n.updatedAt = n.createdAt;
          if (n.isGoldEligible === undefined) n.isGoldEligible = true;
          return n.updatedAt !== q.updatedAt || n.isGoldEligible !== q.isGoldEligible ? n : null;
        });
      }
    };
    req.onsuccess = () => seedIfEmpty(req.result).then(() => resolve(req.result), reject);
    req.onerror = () => reject(req.error);
  });
}

async function seedIfEmpty(db) {
  const tx = db.transaction(['profile', 'attributes'], 'readwrite');
  const existing = await wrap(tx.objectStore('profile').get('player_1'));
  if (!existing) {
    const now = new Date().toISOString();
    tx.objectStore('profile').add({ id: 'player_1', displayName: 'Player', totalXp: 0, difficultyMode: 'normal', weeklyTargetDays: 4, createdAt: now, updatedAt: now });
    DEFAULT_ATTRIBUTES.forEach((a) => tx.objectStore('attributes').add({ ...a, totalXp: 0 }));
  }
  await txDone(tx);
}

export async function getState(db) {
  const tx = db.transaction(STORES, 'readonly');
  const [profiles, attributes, quests, completions, currencyLedger, rewards, redemptions] =
    await Promise.all(STORES.map((st) => wrap(tx.objectStore(st).getAll())));
  return { profile: profiles[0], attributes, quests, completions, currencyLedger, rewards, redemptions };
}

export async function createQuest(db, { title, finishCondition = '', type, effortTier, attributeId, isGoldEligible = true }) {
  title = (title || '').trim();
  if (!title) throw new Error('Title is required.');
  if (!QUEST_TYPES[type]) throw new Error('Unknown quest type.');
  const xpReward = xpForTier(effortTier);
  const tx = db.transaction(['attributes', 'quests'], 'readwrite');
  if (!(await wrap(tx.objectStore('attributes').get(attributeId)))) { tx.abort(); throw new Error('Unknown attribute.'); }
  const quest = { id: newId(), title, finishCondition: (finishCondition || '').trim(), type, effortTier, attributeId, xpReward, status: 'active', isGoldEligible: !!isGoldEligible, createdAt: new Date().toISOString() };
  quest.updatedAt = quest.createdAt;
  tx.objectStore('quests').add(quest);
  await txDone(tx);
  return quest;
}

const abortWith = (tx, msg) => { tx.abort(); throw new Error(msg); };

// Edits change the quest definition only. Past completions keep their own snapshots.
export async function updateQuest(db, id, f) {
  const has = (k) => f[k] !== undefined;
  if (has('title') && !String(f.title).trim()) throw new Error('Title is required.');
  if (has('type') && !QUEST_TYPES[f.type]) throw new Error('Unknown quest type.');
  if (has('effortTier')) xpForTier(f.effortTier);
  const tx = db.transaction(['attributes', 'quests'], 'readwrite');
  const q = await wrap(tx.objectStore('quests').get(id));
  if (!q) abortWith(tx, 'Quest not found.');
  if (has('attributeId') && !(await wrap(tx.objectStore('attributes').get(f.attributeId)))) abortWith(tx, 'Unknown attribute.');
  const next = { ...q, updatedAt: new Date().toISOString() };
  if (has('title')) next.title = String(f.title).trim();
  if (has('finishCondition')) next.finishCondition = String(f.finishCondition).trim();
  if (has('type')) next.type = f.type;
  if (has('attributeId')) next.attributeId = f.attributeId;
  if (has('effortTier')) { next.effortTier = f.effortTier; next.xpReward = xpForTier(f.effortTier); }
  if (has('isGoldEligible')) next.isGoldEligible = !!f.isGoldEligible;
  if (RECURRING.has(next.type) && next.status === 'completed') next.status = 'active'; // recurring quests are never "completed"
  tx.objectStore('quests').put(next);
  await txDone(tx);
  return next;
}

// pause / resume / archive / restore. None of these touch XP, completions or Gold.
export async function changeQuestStatus(db, id, action) {
  const from = { pause: ['active'], resume: ['paused'], archive: ['active', 'paused', 'completed'], restore: ['archived'] }[action];
  if (!from) throw new Error('Unknown quest action.');
  const tx = db.transaction(['quests', 'completions'], 'readwrite');
  const q = await wrap(tx.objectStore('quests').get(id));
  if (!q) abortWith(tx, 'Quest not found.');
  if (!from.includes(q.status)) abortWith(tx, `Cannot ${action} a ${q.status} quest.`);
  let status = { pause: 'paused', resume: 'active', archive: 'archived', restore: 'active' }[action];
  if (action === 'restore' && !RECURRING.has(q.type) && await wrap(tx.objectStore('completions').index('byQuestPeriod').get([id, 'once']))) {
    status = 'completed'; // a one-time quest that was already finished must not become completable again
  }
  tx.objectStore('quests').put({ ...q, status, updatedAt: new Date().toISOString() });
  await txDone(tx);
  return status;
}

// Permanent delete: removes ONLY the quest definition. Completions, XP and ledger rows stay (they keep questId + title snapshot).
export async function deleteQuest(db, id) {
  const tx = db.transaction('quests', 'readwrite');
  if (!(await wrap(tx.objectStore('quests').get(id)))) abortWith(tx, 'Quest not found.');
  tx.objectStore('quests').delete(id);
  await txDone(tx);
}

export async function setWeeklyTarget(db, days) {
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error('Weekly target must be a whole number from 1 to 7.');
  const tx = db.transaction('profile', 'readwrite');
  const p = await wrap(tx.objectStore('profile').get('player_1'));
  p.weeklyTargetDays = days; p.updatedAt = new Date().toISOString();
  tx.objectStore('profile').put(p);
  await txDone(tx);
}

// ONE atomic transaction: completion row + player XP + attribute XP + Gold ledger credit (+ close one-time quests).
// Duplicates are blocked by database indexes, not buttons: the unique [questId, periodKey] completion index and the
// unique ledger transactionKey. Any failure aborts everything, so there is never a completion without its Gold
// (or Gold without its completion).
export function completeQuest(db, questId, now = new Date()) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['quests', 'completions', 'profile', 'attributes', 'currencyLedger'], 'readwrite');
    let outcome, failure;
    tx.oncomplete = () => resolve(outcome);
    tx.onabort = () => reject(failure || tx.error || new Error('Transaction aborted'));
    const fail = (err) => { failure = err; try { tx.abort(); } catch { /* already finished */ } };
    const failOn = (req) => { req.onerror = (ev) => { ev.preventDefault(); fail(ev.target.error && ev.target.error.name === 'ConstraintError' ? new DuplicateCompletionError() : ev.target.error); }; };

    tx.objectStore('quests').get(questId).onsuccess = (e) => {
      const quest = e.target.result;
      if (!quest) return fail(new Error('Quest not found.'));
      if (quest.status !== 'active') return fail(new Error('Quest is not active.'));
      tx.objectStore('profile').get('player_1').onsuccess = (pe) => {
        const profile = pe.target.result;
        const gold = goldAwardFor(quest, profile.difficultyMode);
        const at = now.toISOString(), periodKey = periodKeyFor(quest.type, now);
        const completion = {
          id: newId(), questId, periodKey, questTitleSnapshot: quest.title, attributeId: quest.attributeId,
          effortTier: quest.effortTier, xpAwarded: quest.xpReward, goldAwarded: gold, completedAt: at,
        };
        const add = tx.objectStore('completions').add(completion);
        failOn(add);
        add.onsuccess = () => {
          profile.totalXp += completion.xpAwarded; profile.updatedAt = at;
          tx.objectStore('profile').put(profile);
          tx.objectStore('attributes').get(quest.attributeId).onsuccess = (ae) => {
            const a = ae.target.result;
            a.totalXp += completion.xpAwarded;
            tx.objectStore('attributes').put(a);
          };
          if (gold > 0) {
            failOn(tx.objectStore('currencyLedger').add({
              id: newId(), amount: gold, reason: `Quest completed: ${quest.title}`, relatedCompletionId: completion.id,
              relatedRedemptionId: null, createdAt: at, transactionKey: `completion:${questId}:${periodKey}`,
            }));
          }
          if (!RECURRING.has(quest.type)) tx.objectStore('quests').put({ ...quest, status: 'completed' });
          outcome = completion;
        };
      };
    };
  });
}

// ---- Rewards, redemption and refunds -------------------------------------------
// Every money movement runs in ONE transaction and re-checks the rules inside it (the UI balance is never trusted).
// Overlapping read-write transactions are serialized by IndexedDB, so two simultaneous redemptions cannot both spend the same Gold.
async function inTx(db, stores, fn) {
  const tx = db.transaction(stores, 'readwrite');
  const done = txDone(tx);
  done.catch(() => {}); // surfaced through `await done` below; avoids an unhandled rejection if we abort early
  try {
    const result = await fn(tx);
    await done;
    return result;
  } catch (e) {
    try { tx.abort(); } catch { /* already finished */ }
    throw e;
  }
}

export async function createReward(db, input) {
  const clean = validateReward(input);
  const now = new Date().toISOString();
  const reward = { id: newId(), ...clean, isActive: true, createdAt: now, updatedAt: now };
  await inTx(db, 'rewards', (tx) => { tx.objectStore('rewards').add(reward); });
  return reward;
}

// Editing changes the shop listing only. Past redemptions keep their own title and amount snapshots.
export function updateReward(db, id, fields) {
  return inTx(db, 'rewards', async (tx) => {
    const r = await wrap(tx.objectStore('rewards').get(id));
    if (!r) throw new Error('Reward not found.');
    const clean = validateReward({ title: fields.title ?? r.title, description: fields.description ?? r.description, goldCost: fields.goldCost ?? r.goldCost });
    const next = { ...r, ...clean, updatedAt: new Date().toISOString() };
    tx.objectStore('rewards').put(next);
    return next;
  });
}

// Archive = isActive false; restore = isActive true. Rewards are never deleted (redemptions reference them).
export function setRewardActive(db, id, isActive) {
  return inTx(db, 'rewards', async (tx) => {
    const r = await wrap(tx.objectStore('rewards').get(id));
    if (!r) throw new Error('Reward not found.');
    tx.objectStore('rewards').put({ ...r, isActive: !!isActive, updatedAt: new Date().toISOString() });
  });
}

const mapConstraint = (e, Err) => (e && e.name === 'ConstraintError' ? new Err() : e);

// requestId makes a retry/double-tap idempotent: the same id can only ever be processed once.
export async function redeemReward(db, rewardId, { now = new Date(), requestId } = {}) {
  try {
    return await inTx(db, ['rewards', 'redemptions', 'currencyLedger'], async (tx) => {
      const reward = await wrap(tx.objectStore('rewards').get(rewardId));
      if (!reward) throw new Error('Reward not found.');
      if (!reward.isActive) throw new Error('This reward is archived. Restore it to redeem.');
      const balance = goldBalance(await wrap(tx.objectStore('currencyLedger').getAll()));
      if (balance < reward.goldCost) throw new InsufficientGoldError(balance, reward.goldCost);
      const at = now.toISOString();
      const redemption = { id: requestId || newId(), rewardId, rewardTitleSnapshot: reward.title, goldSpent: reward.goldCost, status: 'redeemed', redeemedAt: at };
      tx.objectStore('redemptions').add(redemption);
      tx.objectStore('currencyLedger').add({
        id: newId(), amount: -reward.goldCost, reason: `Redeemed: ${reward.title}`, relatedCompletionId: null,
        relatedRedemptionId: redemption.id, createdAt: at, transactionKey: `redeem:${redemption.id}`,
      });
      return redemption;
    });
  } catch (e) { throw mapConstraint(e, DuplicateRedemptionError); }
}

// Refund = a NEW positive ledger entry + status change. The original debit is never edited or deleted.
export async function refundRedemption(db, redemptionId, now = new Date()) {
  try {
    return await inTx(db, ['redemptions', 'currencyLedger'], async (tx) => {
      const r = await wrap(tx.objectStore('redemptions').get(redemptionId));
      if (!r) throw new Error('Redemption not found.');
      if (r.status !== 'redeemed') throw new AlreadyRefundedError();
      const at = now.toISOString();
      tx.objectStore('currencyLedger').add({
        id: newId(), amount: r.goldSpent, reason: `Refund: ${r.rewardTitleSnapshot}`, relatedCompletionId: null,
        relatedRedemptionId: r.id, createdAt: at, transactionKey: `refund:${r.id}`,
      });
      const next = { ...r, status: 'refunded', refundedAt: at };
      tx.objectStore('redemptions').put(next);
      return next;
    });
  } catch (e) { throw mapConstraint(e, AlreadyRefundedError); }
}

export async function setDifficultyMode(db, mode) {
  if (!MODES.includes(mode)) throw new Error('Unknown mode.');
  const tx = db.transaction('profile', 'readwrite');
  const p = await wrap(tx.objectStore('profile').get('player_1'));
  p.difficultyMode = mode; p.updatedAt = new Date().toISOString();
  tx.objectStore('profile').put(p);
  await txDone(tx);
}

export async function exportData(db) {
  const s = await getState(db);
  return {
    app: 'life-rpg', schemaVersion: DB_VERSION, exportFormatVersion: EXPORT_FORMAT_VERSION, exportedAt: new Date().toISOString(),
    data: { profile: [s.profile], attributes: s.attributes, quests: s.quests, completions: s.completions,
      currencyLedger: s.currencyLedger, rewards: s.rewards, redemptions: s.redemptions },
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// v1/v2/v3 backup -> v3-shaped data with safe defaults. Never invents Gold or ledger rows.
export function upgradeBackup(b) {
  const d = b.data, fill = (list, defaults) => list.map((r) => (isObj(r) ? { ...defaults(r), ...r } : r));
  return {
    profile: fill(d.profile, () => ({ weeklyTargetDays: 4 })),
    attributes: d.attributes,
    quests: fill(d.quests, (q) => ({ isGoldEligible: true, updatedAt: q.createdAt })),
    completions: d.completions,
    currencyLedger: d.currencyLedger ?? [], rewards: d.rewards ?? [], redemptions: d.redemptions ?? [],
  };
}

// Accepts schemaVersion 1, 2 or 3. Returns upgraded v3 data; throws BackupValidationError; never touches the database.
export function validateBackup(b) {
  const bad = (m) => { throw new BackupValidationError(m); };
  const str = (v) => typeof v === 'string' && v.length > 0;
  const num = (v) => Number.isFinite(v) && v >= 0;
  const int = (v) => Number.isInteger(v);
  const date = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
  if (!isObj(b) || b.app !== 'life-rpg') bad('This file is not a Life RPG backup.');
  if (![1, 2, 3].includes(b.schemaVersion)) bad(`Unsupported schemaVersion: ${b.schemaVersion}.`);
  if (b.exportFormatVersion !== EXPORT_FORMAT_VERSION) bad(`Unsupported exportFormatVersion: ${b.exportFormatVersion}.`);
  if (!isObj(b.data)) bad('Backup has no data section.');
  const required = b.schemaVersion >= 3 ? STORES : STORES.slice(0, 4);
  for (const s of required) if (!Array.isArray(b.data[s])) bad(`Backup is missing the "${s}" list.`);
  for (const s of STORES) if (b.data[s] !== undefined && !Array.isArray(b.data[s])) bad(`"${s}" must be a list.`);
  const d = upgradeBackup(b);

  if (d.profile.length !== 1) bad('Backup must contain exactly one profile.');
  const p = d.profile[0];
  if (!isObj(p) || p.id !== 'player_1' || !str(p.displayName) || !num(p.totalXp) || !MODES.includes(p.difficultyMode)
    || !Number.isInteger(p.weeklyTargetDays) || p.weeklyTargetDays < 1 || p.weeklyTargetDays > 7) bad('Profile data is invalid.');

  const attrIds = new Set();
  for (const a of d.attributes) {
    if (!isObj(a) || !str(a.id) || !str(a.name) || !num(a.totalXp) || attrIds.has(a.id)) bad('Attribute data is invalid.');
    attrIds.add(a.id);
  }
  for (const a of DEFAULT_ATTRIBUTES) if (!attrIds.has(a.id)) bad(`Attribute "${a.name}" is missing.`);

  const questIds = new Set();
  for (const q of d.quests) {
    if (!isObj(q) || !str(q.id) || questIds.has(q.id) || !str(q.title) || !QUEST_TYPES[q.type] || !EFFORT_TIERS[q.effortTier]
      || q.xpReward !== EFFORT_TIERS[q.effortTier].xp || !attrIds.has(q.attributeId)
      || !['active', 'paused', 'completed', 'archived'].includes(q.status) || !str(q.createdAt)
      || typeof q.isGoldEligible !== 'boolean' || !str(q.updatedAt)) bad('Quest data is invalid.');
    questIds.add(q.id);
  }

  // Completions may outlive their quest (permanent deletion keeps history), so questId need not exist in quests.
  const keys = new Set(), compIds = new Set();
  for (const c of d.completions) {
    if (!isObj(c) || !str(c.id) || compIds.has(c.id) || !str(c.questId) || !str(c.periodKey) || !str(c.questTitleSnapshot)
      || !attrIds.has(c.attributeId) || !num(c.xpAwarded) || !date(c.completedAt)
      || (c.goldAwarded !== undefined && !num(c.goldAwarded))) bad('Completion history is invalid.');
    if (c.effortTier !== undefined && !EFFORT_TIERS[c.effortTier]) bad('Completion history is invalid.');
    const k = `${c.questId}|${c.periodKey}`;
    if (keys.has(k)) bad('Completion history contains a duplicate.');
    compIds.add(c.id); keys.add(k);
  }

  const rewardIds = new Set();
  for (const r of d.rewards) {
    if (!isObj(r) || !str(r.id) || rewardIds.has(r.id) || !str(r.title) || (r.description !== undefined && typeof r.description !== 'string')
      || !int(r.goldCost) || r.goldCost < 1 || r.goldCost > 100000 || typeof r.isActive !== 'boolean' || !date(r.createdAt) || !date(r.updatedAt)) bad('Reward data is invalid.');
    rewardIds.add(r.id);
  }
  const redIds = new Set();
  for (const r of d.redemptions) {
    if (!isObj(r) || !str(r.id) || redIds.has(r.id) || !rewardIds.has(r.rewardId) || !str(r.rewardTitleSnapshot)
      || !int(r.goldSpent) || r.goldSpent < 1 || !['redeemed', 'refunded'].includes(r.status) || !date(r.redeemedAt)
      || (r.refundedAt !== undefined && !date(r.refundedAt))) bad('Redemption data is invalid.');
    redIds.add(r.id);
  }

  const txKeys = new Set(), ledgerIds = new Set();
  for (const l of d.currencyLedger) {
    if (!isObj(l) || !str(l.id) || ledgerIds.has(l.id) || !int(l.amount) || l.amount === 0 || !str(l.reason) || !date(l.createdAt)
      || !str(l.transactionKey) || txKeys.has(l.transactionKey)) bad('Gold ledger data is invalid.');
    if (l.relatedCompletionId != null && !compIds.has(l.relatedCompletionId)) bad('A ledger entry points to a missing completion.');
    if (l.relatedRedemptionId != null && !redIds.has(l.relatedRedemptionId)) bad('A ledger entry points to a missing redemption.');
    ledgerIds.add(l.id); txKeys.add(l.transactionKey);
  }
  let balance = 0; // replay in time order (credits first on ties): the balance may never dip below zero
  for (const l of [...d.currencyLedger].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt) || y.amount - x.amount)) {
    balance += l.amount;
    if (balance < 0) bad('Gold ledger would produce a negative balance.');
  }
  for (const c of d.completions) { // no completion may claim Gold that the ledger does not hold
    if (c.goldAwarded > 0 && !d.currencyLedger.some((l) => l.relatedCompletionId === c.id && l.amount === c.goldAwarded)) bad('A completion is missing its Gold credit.');
  }
  for (const r of d.redemptions) {
    const rows = d.currencyLedger.filter((l) => l.relatedRedemptionId === r.id);
    if (!rows.some((l) => l.amount === -r.goldSpent)) bad(`Redemption "${r.rewardTitleSnapshot}" has no matching Gold debit.`);
    if (r.status === 'refunded' && !rows.some((l) => l.amount === r.goldSpent)) bad(`Refunded redemption "${r.rewardTitleSnapshot}" has no matching refund credit.`);
  }
  return d;
}

// Clear + refill every store inside ONE transaction. Any failure aborts and rolls everything back.
export function restoreInTransaction(db, data) {
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of STORES) {
    const store = tx.objectStore(s);
    store.clear();
    data[s].forEach((row) => store.add(row));
  }
  return txDone(tx);
}

export async function importData(db, text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new BackupValidationError('File is not valid JSON.'); }
  const data = validateBackup(parsed);
  await restoreInTransaction(db, data);
}
