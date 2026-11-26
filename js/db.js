// IndexedDB wrapper: schema, seeding, atomic completion, backup/restore.
import { EFFORT_TIERS, QUEST_TYPES, MODES, DEFAULT_ATTRIBUTES, periodKeyFor, xpForTier } from './gameLogic.js';

export const DB_NAME = 'life_rpg';
export const DB_VERSION = 1;
export const EXPORT_FORMAT_VERSION = 1;
const STORES = ['profile', 'attributes', 'quests', 'completions'];

export class DuplicateCompletionError extends Error {
  constructor() { super('Already completed for this period.'); this.name = 'DuplicateCompletionError'; }
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
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('profile', { keyPath: 'id' });
        db.createObjectStore('attributes', { keyPath: 'id' });
        db.createObjectStore('quests', { keyPath: 'id' });
        const c = db.createObjectStore('completions', { keyPath: 'id' });
        c.createIndex('byQuestPeriod', ['questId', 'periodKey'], { unique: true });
        c.createIndex('byCompletedAt', 'completedAt');
      }
      // Future versions: add `if (e.oldVersion < 2) { ... }` blocks here.
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
    tx.objectStore('profile').add({ id: 'player_1', displayName: 'Player', totalXp: 0, difficultyMode: 'normal', createdAt: now, updatedAt: now });
    DEFAULT_ATTRIBUTES.forEach((a) => tx.objectStore('attributes').add({ ...a, totalXp: 0 }));
  }
  await txDone(tx);
}

export async function getState(db) {
  const tx = db.transaction(STORES, 'readonly');
  const [profiles, attributes, quests, completions] = await Promise.all(STORES.map((s) => wrap(tx.objectStore(s).getAll())));
  return { profile: profiles[0], attributes, quests, completions };
}

export async function createQuest(db, { title, finishCondition = '', type, effortTier, attributeId }) {
  title = (title || '').trim();
  if (!title) throw new Error('Title is required.');
  if (!QUEST_TYPES[type]) throw new Error('Unknown quest type.');
  const xpReward = xpForTier(effortTier);
  const tx = db.transaction(['attributes', 'quests'], 'readwrite');
  if (!(await wrap(tx.objectStore('attributes').get(attributeId)))) { tx.abort(); throw new Error('Unknown attribute.'); }
  const quest = { id: newId(), title, finishCondition: (finishCondition || '').trim(), type, effortTier, attributeId, xpReward, status: 'active', createdAt: new Date().toISOString() };
  tx.objectStore('quests').add(quest);
  await txDone(tx);
  return quest;
}

// One atomic transaction: completion row + player XP + attribute XP (+ close one-time quests).
// The unique [questId, periodKey] index makes duplicates structurally impossible.
export function completeQuest(db, questId, now = new Date()) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['quests', 'completions', 'profile', 'attributes'], 'readwrite');
    let outcome, failure;
    tx.oncomplete = () => resolve(outcome);
    tx.onabort = () => reject(failure || tx.error || new Error('Transaction aborted'));
    const fail = (err) => { failure = err; try { tx.abort(); } catch { /* already finished */ } };

    tx.objectStore('quests').get(questId).onsuccess = (e) => {
      const quest = e.target.result;
      if (!quest) return fail(new Error('Quest not found.'));
      if (quest.status !== 'active') return fail(new Error('Quest is not active.'));
      const completion = {
        id: newId(), questId, periodKey: periodKeyFor(quest.type, now), questTitleSnapshot: quest.title,
        attributeId: quest.attributeId, xpAwarded: quest.xpReward, completedAt: now.toISOString(),
      };
      const add = tx.objectStore('completions').add(completion);
      add.onerror = (ev) => {
        ev.preventDefault();
        fail(ev.target.error && ev.target.error.name === 'ConstraintError' ? new DuplicateCompletionError() : ev.target.error);
      };
      add.onsuccess = () => {
        tx.objectStore('profile').get('player_1').onsuccess = (pe) => {
          const p = pe.target.result;
          p.totalXp += completion.xpAwarded; p.updatedAt = completion.completedAt;
          tx.objectStore('profile').put(p);
        };
        tx.objectStore('attributes').get(quest.attributeId).onsuccess = (ae) => {
          const a = ae.target.result;
          a.totalXp += completion.xpAwarded;
          tx.objectStore('attributes').put(a);
        };
        if (quest.type !== 'daily' && quest.type !== 'weekly') tx.objectStore('quests').put({ ...quest, status: 'completed' });
        outcome = completion;
      };
    };
  });
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
    data: { profile: [s.profile], attributes: s.attributes, quests: s.quests, completions: s.completions },
  };
}

// Throws BackupValidationError; never touches the database.
export function validateBackup(b) {
  const bad = (m) => { throw new BackupValidationError(m); };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => typeof v === 'string' && v.length > 0;
  const num = (v) => Number.isFinite(v) && v >= 0;
  if (!isObj(b) || b.app !== 'life-rpg') bad('This file is not a Life RPG backup.');
  if (b.schemaVersion !== DB_VERSION) bad(`Unsupported schemaVersion: ${b.schemaVersion}.`);
  if (b.exportFormatVersion !== EXPORT_FORMAT_VERSION) bad(`Unsupported exportFormatVersion: ${b.exportFormatVersion}.`);
  const d = b.data;
  if (!isObj(d)) bad('Backup has no data section.');
  for (const s of STORES) if (!Array.isArray(d[s])) bad(`Backup is missing the "${s}" list.`);

  if (d.profile.length !== 1) bad('Backup must contain exactly one profile.');
  const p = d.profile[0];
  if (!isObj(p) || p.id !== 'player_1' || !str(p.displayName) || !num(p.totalXp) || !MODES.includes(p.difficultyMode)) bad('Profile data is invalid.');

  const attrIds = new Set();
  for (const a of d.attributes) {
    if (!isObj(a) || !str(a.id) || !str(a.name) || !num(a.totalXp) || attrIds.has(a.id)) bad('Attribute data is invalid.');
    attrIds.add(a.id);
  }
  for (const a of DEFAULT_ATTRIBUTES) if (!attrIds.has(a.id)) bad(`Attribute "${a.name}" is missing.`);

  const questIds = new Set();
  for (const q of d.quests) {
    if (!isObj(q) || !str(q.id) || questIds.has(q.id) || !str(q.title) || !QUEST_TYPES[q.type] || !EFFORT_TIERS[q.effortTier]
      || q.xpReward !== EFFORT_TIERS[q.effortTier].xp || !attrIds.has(q.attributeId) || !['active', 'completed'].includes(q.status) || !str(q.createdAt)) bad('Quest data is invalid.');
    questIds.add(q.id);
  }
  const keys = new Set(), ids = new Set();
  for (const c of d.completions) {
    if (!isObj(c) || !str(c.id) || ids.has(c.id) || !questIds.has(c.questId) || !str(c.periodKey) || !str(c.questTitleSnapshot)
      || !attrIds.has(c.attributeId) || !num(c.xpAwarded) || Number.isNaN(Date.parse(c.completedAt))) bad('Completion history is invalid.');
    const k = `${c.questId}|${c.periodKey}`;
    if (keys.has(k)) bad('Completion history contains a duplicate.');
    ids.add(c.id); keys.add(k);
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
