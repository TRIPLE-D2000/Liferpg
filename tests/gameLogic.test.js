// Zero-dependency test runner. Serve the project over http (not file://) and open tests/test.html.
import { EFFORT_TIERS, xpForTier, xpForLevel, levelFromXp, localDayKey, localWeekKey, periodKeyFor, prepareBoard, weekDays, weeklyConsistency, GOLD_BY_TIER, goldForTier, goldAwardFor, goldBalance, validateReward, buildHistory } from '../js/gameLogic.js';
import { createAuth, classify } from '../js/auth.js';
import { openDatabase, getState, createQuest, completeQuest, updateQuest, changeQuestStatus, deleteQuest, setWeeklyTarget, setDifficultyMode, createReward, updateReward, setRewardActive, redeemReward, refundRedemption, InsufficientGoldError, DuplicateRedemptionError, AlreadyRefundedError, exportData, importData, restoreInTransaction, DuplicateCompletionError, BackupValidationError } from '../js/db.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, msg) => { if (!c) throw new Error(msg); };
async function rejects(p, name) {
  try { await p; } catch (e) { if (name && e.name !== name) throw new Error(`Expected ${name}, got ${e.name}: ${e.message}`); return; }
  throw new Error('Expected rejection, but it resolved');
}
async function withDb(fn) {
  const name = 'life_rpg_test_' + Math.random().toString(36).slice(2);
  const db = await openDatabase(name);
  try { await fn(db); } finally { db.close(); indexedDB.deleteDatabase(name); }
}
const quest = (db, o = {}) => createQuest(db, { title: 'Test quest', type: 'daily', effortTier: 'standard', attributeId: 'mind', ...o });
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min); // local time

// ---- XP and levels
test('effort tiers map to 5/10/25/50 XP', () => {
  eq(['small', 'standard', 'meaningful', 'major'].map(xpForTier), [5, 10, 25, 50]);
  eq(Object.keys(EFFORT_TIERS).length, 4);
});
test('level thresholds are 0,100,250,450,700,1000', () => eq([1, 2, 3, 4, 5, 6].map(xpForLevel), [0, 100, 250, 450, 700, 1000]));
test('levels derive from total XP at every boundary', () => {
  const cases = [[0, 1], [99, 1], [100, 2], [249, 2], [250, 3], [449, 3], [450, 4], [699, 4], [700, 5], [999, 5], [1000, 6]];
  for (const [xp, lvl] of cases) eq(levelFromXp(xp), lvl, `xp ${xp}:`);
});

// ---- Period keys
test('daily key uses the local calendar day', () => {
  eq(localDayKey(at(2026, 11, 26)), '2026-11-26');
  ok(localDayKey(at(2026, 11, 26, 23, 59)) !== localDayKey(at(2026, 11, 27, 0, 1)), 'resets at local midnight');
});
test('weekly key is an ISO local week', () => {
  eq(localWeekKey(at(2026, 11, 26)), '2026-W48');
  eq(localWeekKey(at(2026, 11, 29, 23, 59)), '2026-W48');
  eq(localWeekKey(at(2026, 11, 30, 0, 1)), '2026-W49');
  eq(localWeekKey(at(2024, 12, 31)), '2025-W01');
  eq(localWeekKey(at(2027, 1, 1)), '2026-W53');
});
test('periodKeyFor: once for non-recurring types', () => {
  for (const t of ['main', 'milestone', 'side']) eq(periodKeyFor(t, at(2026, 11, 26)), 'once');
  eq(periodKeyFor('daily', at(2026, 11, 26)), '2026-11-26');
  eq(periodKeyFor('weekly', at(2026, 11, 26)), '2026-W48');
});

// ---- Database
test('database seeds 1 profile and 4 attributes', () => withDb(async (db) => {
  const s = await getState(db);
  eq(s.profile.id, 'player_1'); eq(s.profile.totalXp, 0); eq(s.profile.difficultyMode, 'normal');
  eq(s.attributes.map((a) => a.name).sort(), ['Body', 'Craft', 'Mind', 'Order']);
  ok(!('level' in s.profile), 'level must not be stored');
}));
test('completing a quest adds XP to player and attribute atomically', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main', effortTier: 'major', attributeId: 'craft' });
  const c = await completeQuest(db, q.id, at(2026, 11, 26));
  eq(c.periodKey, 'once'); eq(c.xpAwarded, 50); eq(c.questTitleSnapshot, 'Test quest');
  const s = await getState(db);
  eq(s.profile.totalXp, 50); eq(s.attributes.find((a) => a.id === 'craft').totalXp, 50);
  eq(s.completions.length, 1); eq(s.quests[0].status, 'completed');
}));
test('one-time quest cannot be completed twice', () => withDb(async (db) => {
  const q = await quest(db, { type: 'side' });
  await completeQuest(db, q.id);
  await rejects(completeQuest(db, q.id));
  eq((await getState(db)).profile.totalXp, 10);
}));
test("unique [questId, periodKey] index rejects a duplicate 'once' row", () => withDb(async (db) => {
  const row = (id) => ({ id, questId: 'q1', periodKey: 'once', questTitleSnapshot: 't', attributeId: 'mind', xpAwarded: 5, completedAt: new Date().toISOString() });
  const err = await new Promise((res) => {
    const st = db.transaction('completions', 'readwrite').objectStore('completions');
    st.add(row('a'));
    const r = st.add(row('b'));
    r.onerror = (e) => { e.preventDefault(); res(r.error.name); };
    r.onsuccess = () => res('no error');
  });
  eq(err, 'ConstraintError');
}));
test('daily quest: same day rejected, next local day allowed', () => withDb(async (db) => {
  const q = await quest(db, { type: 'daily' });
  await completeQuest(db, q.id, at(2026, 11, 26, 8));
  await rejects(completeQuest(db, q.id, at(2026, 11, 26, 23, 59)), 'DuplicateCompletionError');
  await completeQuest(db, q.id, at(2026, 11, 27, 0, 1));
  const s = await getState(db);
  eq(s.completions.length, 2); eq(s.profile.totalXp, 20);
}));
test('weekly quest: same week rejected, next week allowed', () => withDb(async (db) => {
  const q = await quest(db, { type: 'weekly' });
  await completeQuest(db, q.id, at(2026, 11, 23));
  await rejects(completeQuest(db, q.id, at(2026, 11, 29, 23, 59)), 'DuplicateCompletionError');
  await completeQuest(db, q.id, at(2026, 11, 30, 0, 1));
  eq((await getState(db)).completions.map((c) => c.periodKey).sort(), ['2026-W48', '2026-W49']);
}));
test('rejected duplicate leaves XP unchanged', () => withDb(async (db) => {
  const q = await quest(db, { type: 'daily', effortTier: 'meaningful' });
  await completeQuest(db, q.id, at(2026, 11, 26));
  await rejects(completeQuest(db, q.id, at(2026, 11, 26, 20)), 'DuplicateCompletionError');
  const s = await getState(db);
  eq(s.profile.totalXp, 25); eq(s.attributes.find((a) => a.id === 'mind').totalXp, 25);
}));

// ---- Backup / restore
test('export then import restores progress', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main' });
  await completeQuest(db, q.id);
  const backup = JSON.stringify(await exportData(db));
  const b = JSON.parse(backup);
  eq([b.app, b.schemaVersion, b.exportFormatVersion], ['life-rpg', 3, 1]);
  const q2 = await quest(db, { type: 'main', effortTier: 'major' });
  await completeQuest(db, q2.id);
  eq((await getState(db)).profile.totalXp, 60);
  await importData(db, backup);
  const s = await getState(db);
  eq(s.profile.totalXp, 10); eq(s.quests.length, 1); eq(s.completions.length, 1);
}));
test('invalid backups are rejected and existing data is untouched', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main' });
  await completeQuest(db, q.id);
  const before = JSON.stringify(await getState(db));
  const good = await exportData(db);
  const clone = () => JSON.parse(JSON.stringify(good));
  const wrongApp = clone(); wrongApp.app = 'other';
  const wrongSchema = clone(); wrongSchema.schemaVersion = 99;
  const noData = clone(); delete noData.data.quests;
  const badQuest = clone(); badQuest.data.quests[0].effortTier = 'huge';
  const dupe = clone(); dupe.data.completions.push({ ...dupe.data.completions[0], id: 'dup' });
  const badXp = clone(); badXp.data.profile[0].totalXp = -5;
  for (const bad of ['not json {', '[]', JSON.stringify(wrongApp), JSON.stringify(wrongSchema), JSON.stringify(noData), JSON.stringify(badQuest), JSON.stringify(dupe), JSON.stringify(badXp)]) {
    await rejects(importData(db, bad), 'BackupValidationError');
  }
  eq(JSON.stringify(await getState(db)), before, 'state changed:');
}));
test('restore is atomic: a mid-write failure rolls back everything', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main' });
  await completeQuest(db, q.id);
  const before = JSON.stringify(await getState(db));
  const data = (await exportData(db)).data;
  data.profile[0].totalXp = 9999; // would be visible if the restore leaked
  data.completions.push({ ...data.completions[0], id: 'dup-row' }); // violates the unique index mid-write
  await rejects(restoreInTransaction(db, data));
  eq(JSON.stringify(await getState(db)), before, 'rollback failed:');
}));

// ---- Migration (DB v1/v2 -> v3) and v1/v2/v3 backups
const T = '2026-11-20T10:00:00.000Z';
const rawOpen = (name, version, upgrade) => new Promise((res, rej) => {
  const r = indexedDB.open(name, version);
  r.onupgradeneeded = () => upgrade(r.result);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const putAll = (db, store, rows) => new Promise((res, rej) => {
  const tx = db.transaction(store, 'readwrite');
  rows.forEach((r) => tx.objectStore(store).put(r));
  tx.oncomplete = res; tx.onerror = () => rej(tx.error);
});
function legacySchema(db) { // exactly the Phase 1 schema
  db.createObjectStore('profile', { keyPath: 'id' });
  db.createObjectStore('attributes', { keyPath: 'id' });
  db.createObjectStore('quests', { keyPath: 'id' });
  const c = db.createObjectStore('completions', { keyPath: 'id' });
  c.createIndex('byQuestPeriod', ['questId', 'periodKey'], { unique: true });
  c.createIndex('byCompletedAt', 'completedAt');
}
const attrRows = () => ['craft', 'body', 'mind', 'order'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), totalXp: id === 'mind' ? 35 : 0 }));
async function withLegacy(version, profileExtra, questExtra, fn) {
  const name = 'life_rpg_legacy_' + Math.random().toString(36).slice(2);
  const raw = await rawOpen(name, version, legacySchema);
  await putAll(raw, 'profile', [{ id: 'player_1', displayName: 'Daniel', totalXp: 35, difficultyMode: 'gentle', createdAt: T, updatedAt: T, ...profileExtra }]);
  await putAll(raw, 'attributes', attrRows());
  await putAll(raw, 'quests', [{ id: 'q1', title: 'Read', finishCondition: '', type: 'daily', effortTier: 'standard', attributeId: 'mind', xpReward: 10, status: 'active', createdAt: T, ...questExtra }]);
  await putAll(raw, 'completions', [{ id: 'c1', questId: 'q1', periodKey: '2026-11-20', questTitleSnapshot: 'Read', attributeId: 'mind', xpAwarded: 35, completedAt: T }]);
  raw.close();
  const db = await openDatabase(name);
  try { await fn(db); } finally { db.close(); indexedDB.deleteDatabase(name); }
}
const storeNames = (db) => [...db.objectStoreNames].sort();
const V3_STORES = ['attributes', 'completions', 'currencyLedger', 'profile', 'quests', 'redemptions', 'rewards'];

test('fresh database is v3 with the new stores and indexes', () => withDb(async (db) => {
  eq(db.version, 3); eq(storeNames(db), V3_STORES);
  const tx = db.transaction(['currencyLedger', 'rewards', 'redemptions'], 'readonly');
  eq([...tx.objectStore('currencyLedger').indexNames].sort(), ['byCompletion', 'byCreatedAt', 'byRedemption', 'byTransactionKey']);
  eq([...tx.objectStore('rewards').indexNames], ['byCreatedAt']);
  eq([...tx.objectStore('redemptions').indexNames].sort(), ['byRedeemedAt', 'byRewardId']);
  eq((await getState(db)).profile.weeklyTargetDays, 4);
}));
test('ledger transactionKey is unique at the database layer', () => withDb(async (db) => {
  const row = (id) => ({ id, amount: 5, reason: 'x', relatedCompletionId: null, relatedRedemptionId: null, createdAt: T, transactionKey: 'same' });
  const err = await new Promise((res) => {
    const st = db.transaction('currencyLedger', 'readwrite').objectStore('currencyLedger');
    st.add(row('a'));
    const r = st.add(row('b'));
    r.onerror = (e) => { e.preventDefault(); res(r.error.name); };
    r.onsuccess = () => res('no error');
  });
  eq(err, 'ConstraintError');
}));
test('v1 -> v3 migration preserves data and adds safe defaults', () => withLegacy(1, {}, {}, async (db) => {
  eq(db.version, 3); eq(storeNames(db), V3_STORES);
  const s = await getState(db);
  eq([s.profile.totalXp, s.profile.difficultyMode, s.profile.displayName], [35, 'gentle', 'Daniel']);
  eq(s.profile.weeklyTargetDays, 4);
  eq(s.attributes.find((a) => a.id === 'mind').totalXp, 35);
  eq([s.quests[0].isGoldEligible, s.quests[0].updatedAt, s.quests[0].status, s.quests[0].title], [true, T, 'active', 'Read']);
  eq(s.completions.length, 1); eq(s.completions[0].xpAwarded, 35);
  ok(!('goldAwarded' in s.completions[0]), 'old completions must not gain Gold');
  eq(s.currencyLedger.length, 0); eq(s.rewards.length, 0); eq(s.redemptions.length, 0);
}));
test('v2 -> v3 migration keeps Phase 2 values and adds Gold fields', () =>
  withLegacy(2, { weeklyTargetDays: 6 }, { updatedAt: '2026-11-22T00:00:00.000Z', status: 'paused' }, async (db) => {
    eq(db.version, 3);
    const s = await getState(db);
    eq(s.profile.weeklyTargetDays, 6);
    eq([s.quests[0].updatedAt, s.quests[0].status, s.quests[0].isGoldEligible], ['2026-11-22T00:00:00.000Z', 'paused', true]);
    eq(s.currencyLedger.length, 0);
  }));
test('migrated database still completes quests correctly', () => withLegacy(1, {}, {}, async (db) => {
  const c = await completeQuest(db, 'q1', at(2026, 11, 26));
  eq(c.xpAwarded, 10);
  await rejects(completeQuest(db, 'q1', at(2026, 11, 26, 20)), 'DuplicateCompletionError');
  eq((await getState(db)).profile.totalXp, 45);
}));

const baseData = () => ({
  profile: [{ id: 'player_1', displayName: 'Player', totalXp: 10, difficultyMode: 'normal', createdAt: T, updatedAt: T }],
  attributes: attrRows().map((a) => ({ ...a, totalXp: a.id === 'mind' ? 10 : 0 })),
  quests: [{ id: 'q1', title: 'Old quest', finishCondition: '', type: 'main', effortTier: 'standard', attributeId: 'mind', xpReward: 10, status: 'completed', createdAt: T }],
  completions: [{ id: 'c1', questId: 'q1', periodKey: 'once', questTitleSnapshot: 'Old quest', attributeId: 'mind', xpAwarded: 10, completedAt: T }],
});
const backup = (v, data) => JSON.stringify({ app: 'life-rpg', schemaVersion: v, exportFormatVersion: 1, exportedAt: T, data });
const goldData = () => ({
  ...baseData(),
  rewards: [{ id: 'r1', title: 'Movie night', description: '', goldCost: 30, isActive: true, createdAt: T, updatedAt: T }],
  redemptions: [{ id: 'd1', rewardId: 'r1', rewardTitleSnapshot: 'Movie night', goldSpent: 30, status: 'redeemed', redeemedAt: '2026-11-21T10:00:00.000Z' }],
  currencyLedger: [
    { id: 'l1', amount: 50, reason: 'Quest completed', relatedCompletionId: 'c1', relatedRedemptionId: null, createdAt: T, transactionKey: 'completion:c1' },
    { id: 'l2', amount: -30, reason: 'Reward redeemed', relatedCompletionId: null, relatedRedemptionId: 'd1', createdAt: '2026-11-21T10:00:00.000Z', transactionKey: 'redeem:d1' },
  ],
});
const sumLedger = (s) => s.currencyLedger.reduce((n, l) => n + l.amount, 0);
const patched = (fn) => { const d = goldData(); fn(d); return backup(3, d); };

test('v1 backup imports with defaults and no retroactive Gold', () => withDb(async (db) => {
  await importData(db, backup(1, baseData()));
  const s = await getState(db);
  eq([s.profile.weeklyTargetDays, s.quests[0].isGoldEligible, s.quests[0].updatedAt], [4, true, T]);
  eq(s.completions.length, 1); ok(!('goldAwarded' in s.completions[0]), 'no goldAwarded');
  eq(s.currencyLedger.length, 0); eq(sumLedger(s), 0);
}));
test('v2 backup imports and keeps weeklyTargetDays', () => withDb(async (db) => {
  const d = baseData(); d.profile[0].weeklyTargetDays = 6;
  await importData(db, backup(2, d));
  const s = await getState(db);
  eq([s.profile.weeklyTargetDays, sumLedger(s)], [6, 0]);
}));
test('v3 backup restores ledger, rewards, redemptions and the derived balance', () => withDb(async (db) => {
  await importData(db, backup(3, goldData()));
  const s = await getState(db);
  eq([s.rewards.length, s.redemptions.length, s.currencyLedger.length], [1, 1, 2]);
  eq(sumLedger(s), 20);
  const again = JSON.parse(JSON.stringify(await exportData(db)));
  eq([again.schemaVersion, again.data.currencyLedger.length], [3, 2]);
}));
test('completions whose quest was deleted are valid history', () => withDb(async (db) => {
  const d = baseData(); d.quests = [];
  await importData(db, backup(1, d));
  eq((await getState(db)).completions[0].questTitleSnapshot, 'Old quest');
}));
test('invalid v3 backups are rejected without touching existing data', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main' });
  await completeQuest(db, q.id);
  const before = JSON.stringify(await getState(db));
  const bads = [
    patched((d) => { d.currencyLedger[1].transactionKey = 'completion:c1'; }),          // duplicate transaction key
    patched((d) => { d.currencyLedger[0].amount = 0; }),                                  // zero amount
    patched((d) => { d.currencyLedger[0].amount = 2.5; }),                                // non-integer
    patched((d) => { d.currencyLedger[0].amount = 10; }),                                 // 10 - 30 < 0
    patched((d) => { d.currencyLedger[1].relatedRedemptionId = 'nope'; }),                // dangling redemption
    patched((d) => { d.currencyLedger[0].relatedCompletionId = 'nope'; }),                // dangling completion
    patched((d) => { d.currencyLedger.pop(); }),                                          // redemption without debit
    patched((d) => { d.redemptions[0].rewardId = 'nope'; }),                              // unknown reward
    patched((d) => { d.rewards[0].goldCost = 0; }),                                       // bad cost
    patched((d) => { d.redemptions[0].status = 'refunded'; }),                            // refunded with no refund credit
    patched((d) => { delete d.rewards; }),                                                // v3 must include every store
    backup(4, goldData()),                                                                // unknown future version
  ];
  for (const bad of bads) await rejects(importData(db, bad), 'BackupValidationError');
  eq(JSON.stringify(await getState(db)), before, 'state changed:');
}));

// ---- Phase 2: modes
const mq = (id, effortTier, type = 'side', createdAt = T) => ({ id, title: id, type, effortTier, status: 'active', createdAt });
const board = [mq('big', 'major', 'main', '2026-01-01'), mq('tiny', 'small', 'side', '2026-01-02'), mq('mid', 'standard', 'daily', '2026-01-03'), mq('heavy', 'meaningful', 'weekly', '2026-01-04'),
  { ...mq('gone', 'small'), status: 'paused' }, { ...mq('old', 'small'), status: 'archived' }];
const ids = (b) => b.items.map((i) => i.quest.id);

test('Normal mode: active quests only, ordered by type, nothing collapsed', () => {
  const b = prepareBoard(board, 'normal');
  eq(ids(b), ['big', 'mid', 'heavy', 'tiny']); eq(b.resting, false); ok(b.items.every((i) => !i.collapsed), 'none collapsed');
  eq(ids(prepareBoard(board, 'normal', { filter: 'daily' })), ['mid']);
});
test('Gentle mode: small tasks first, heavy ones collapsed until expanded', () => {
  const b = prepareBoard(board, 'gentle');
  eq(ids(b), ['tiny', 'mid', 'heavy', 'big']);
  eq(b.items.map((i) => i.collapsed), [false, false, true, true]);
  eq(prepareBoard(board, 'gentle', { expanded: new Set(['big']) }).items.find((i) => i.quest.id === 'big').collapsed, false);
  eq(ids(prepareBoard(board, 'gentle')).length, 4, 'nothing is removed or required');
});
test('Rest mode hides the board unless "view anyway" is on', () => {
  eq(prepareBoard(board, 'rest'), { resting: true, items: [] });
  const b = prepareBoard(board, 'rest', { showAnyway: true });
  eq([b.resting, ids(b).length], [true, 4]);
});
test('mode persists across reopen and never changes history or XP', async () => {
  const name = 'life_rpg_mode_' + Math.random().toString(36).slice(2);
  let db = await openDatabase(name);
  try {
    const q = await quest(db, { type: 'main' });
    await completeQuest(db, q.id, at(2026, 11, 26));
    const before = await getState(db);
    for (const m of ['gentle', 'rest', 'normal', 'rest']) await setDifficultyMode(db, m);
    db.close(); db = await openDatabase(name);
    const after = await getState(db);
    eq(after.profile.difficultyMode, 'rest');
    eq([after.profile.totalXp, JSON.stringify(after.completions)], [before.profile.totalXp, JSON.stringify(before.completions)]);
    await rejects(setDifficultyMode(db, 'turbo'));
  } finally { db.close(); indexedDB.deleteDatabase(name); }
});

// ---- Phase 2: weekly consistency
const cAt = (...a) => ({ completedAt: at(...a).toISOString() });
test('weeks start on Monday and Sunday belongs to the previous week', () => {
  eq(weekDays(at(2026, 11, 25)), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
  eq(weekDays(at(2026, 11, 29, 23, 59))[0], '2026-11-23');
  eq(weekDays(at(2026, 11, 30, 0, 1))[0], '2026-11-30');
});
test('weeks cross month and year boundaries correctly', () => {
  eq(weekDays(at(2026, 12, 3)), ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']);
  eq(weekDays(at(2027, 1, 1)), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  eq(weekDays(at(2024, 3, 1))[0], '2024-02-26'); // leap year
});
test('one active day = at least one completion; several on one day count once', () => {
  const now = at(2026, 11, 26);
  eq(weeklyConsistency([], now, 4).count, 0);
  eq(weeklyConsistency([cAt(2026, 11, 24, 9)], now, 4).count, 1);
  eq(weeklyConsistency([cAt(2026, 11, 24, 9), cAt(2026, 11, 24, 12), cAt(2026, 11, 24, 21), cAt(2026, 11, 25, 8)], now, 4).count, 2);
  eq(weeklyConsistency([cAt(2026, 11, 22, 12), cAt(2026, 11, 30, 12)], now, 4).count, 0, 'other weeks ignored');
});
test('days are local calendar days, not UTC days', () => {
  const wc = weeklyConsistency([cAt(2026, 11, 25, 23, 30), cAt(2026, 11, 26, 0, 30)], at(2026, 11, 26), 4);
  eq(wc.days.map((d) => d.active), [false, false, true, true, false, false, false]);
});
test('target changes only the target and percentage; a missed target has no penalty', () => {
  const done = [cAt(2026, 11, 23), cAt(2026, 11, 24), cAt(2026, 11, 25)], now = at(2026, 11, 26);
  const frozen = JSON.stringify(done);
  const a = weeklyConsistency(done, now, 4), b = weeklyConsistency(done, now, 3), c = weeklyConsistency(done, now, 7);
  eq([a.count, a.pct, a.reached], [3, 75, false]); eq([b.pct, b.reached], [100, true]); eq(c.pct, 43);
  eq(JSON.stringify(done), frozen, 'input untouched');
  ok(!/miss|broken|lost|streak/i.test(a.message + weeklyConsistency([], now, 4).message), 'no shaming language');
});
test('weekly target persists and is validated', () => withDb(async (db) => {
  await setWeeklyTarget(db, 6);
  eq((await getState(db)).profile.weeklyTargetDays, 6);
  for (const bad of [0, 8, 2.5, '4', NaN]) await rejects(setWeeklyTarget(db, bad));
  eq((await getState(db)).profile.weeklyTargetDays, 6);
}));
test('missing days never reduce XP', () => withDb(async (db) => {
  const q = await quest(db, { type: 'daily' });
  await completeQuest(db, q.id, at(2026, 11, 2));
  await completeQuest(db, q.id, at(2026, 11, 20)); // 17 skipped days in between
  const s = await getState(db);
  eq([s.profile.totalXp, s.completions.length], [20, 2]);
}));

// ---- Phase 2: quest lifecycle
test('new quests are Gold-eligible by default and carry updatedAt', () => withDb(async (db) => {
  const q = await quest(db);
  eq([q.isGoldEligible, q.updatedAt === q.createdAt, q.status], [true, true, 'active']);
  eq((await quest(db, { isGoldEligible: false })).isGoldEligible, false);
}));
test('editing changes future completions only; history keeps its snapshots', () => withDb(async (db) => {
  const q = await quest(db, { title: 'Read', type: 'daily', effortTier: 'standard', attributeId: 'mind' });
  const first = await completeQuest(db, q.id, at(2026, 11, 26));
  const edited = await updateQuest(db, q.id, { title: 'Read 20 pages', effortTier: 'meaningful', attributeId: 'craft', finishCondition: 'timer done', isGoldEligible: false });
  eq([edited.xpReward, edited.title, edited.attributeId, edited.isGoldEligible], [25, 'Read 20 pages', 'craft', false]);
  let s = await getState(db);
  eq(JSON.stringify(s.completions[0]), JSON.stringify(first), 'old completion untouched');
  eq([s.completions[0].questTitleSnapshot, s.completions[0].xpAwarded, s.completions[0].attributeId], ['Read', 10, 'mind']);
  const next = await completeQuest(db, q.id, at(2026, 11, 27));
  eq([next.questTitleSnapshot, next.xpAwarded, next.attributeId], ['Read 20 pages', 25, 'craft']);
  s = await getState(db);
  eq([s.profile.totalXp, s.attributes.find((a) => a.id === 'mind').totalXp, s.attributes.find((a) => a.id === 'craft').totalXp], [35, 10, 25]);
}));
test('edit validation rejects bad input and leaves the quest alone', () => withDb(async (db) => {
  const q = await quest(db);
  for (const bad of [{ title: '   ' }, { type: 'epic' }, { effortTier: 'huge' }, { attributeId: 'luck' }]) await rejects(updateQuest(db, q.id, bad));
  await rejects(updateQuest(db, 'missing', { title: 'x' }));
  eq((await getState(db)).quests[0].title, 'Test quest');
}));
test('pause hides a quest and blocks completion; resume brings it back', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main' });
  eq(await changeQuestStatus(db, q.id, 'pause'), 'paused');
  ok(prepareBoard((await getState(db)).quests, 'normal').items.length === 0, 'hidden from board');
  await rejects(completeQuest(db, q.id));
  eq(await changeQuestStatus(db, q.id, 'resume'), 'active');
  await completeQuest(db, q.id);
}));
test('archive and restore never create XP or completions', () => withDb(async (db) => {
  const d = await quest(db, { type: 'daily' });
  await completeQuest(db, d.id, at(2026, 11, 26));
  const before = await getState(db);
  await changeQuestStatus(db, d.id, 'archive'); await changeQuestStatus(db, d.id, 'restore');
  const after = await getState(db);
  eq([after.quests[0].status, after.profile.totalXp, after.completions.length], ['active', before.profile.totalXp, 1]);
  await rejects(completeQuest(db, d.id, at(2026, 11, 26, 20)), 'DuplicateCompletionError');
}));
test('a finished one-time quest restores as completed, not completable again', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main' });
  await completeQuest(db, q.id);
  await changeQuestStatus(db, q.id, 'archive');
  eq(await changeQuestStatus(db, q.id, 'restore'), 'completed');
  await rejects(completeQuest(db, q.id));
  eq((await getState(db)).profile.totalXp, 10);
}));
test('invalid lifecycle transitions are rejected', () => withDb(async (db) => {
  const q = await quest(db);
  await rejects(changeQuestStatus(db, q.id, 'resume'));
  await rejects(changeQuestStatus(db, q.id, 'restore'));
  await rejects(changeQuestStatus(db, q.id, 'explode'));
  await rejects(changeQuestStatus(db, 'missing', 'pause'));
  eq((await getState(db)).quests[0].status, 'active');
}));
test('permanent delete removes only the quest; history, XP and ledger rows survive', () => withDb(async (db) => {
  const q = await quest(db, { title: 'Doomed', type: 'daily', effortTier: 'major' });
  const c = await completeQuest(db, q.id, at(2026, 11, 26));
  const archivedOne = await quest(db, { title: 'Other' });
  await changeQuestStatus(db, archivedOne.id, 'archive');
  await deleteQuest(db, q.id);
  const s = await getState(db);
  eq(s.quests.map((x) => x.title), ['Other']);
  eq([s.completions.length, s.completions[0].questTitleSnapshot, s.completions[0].xpAwarded, s.completions[0].questId], [1, 'Doomed', 50, q.id]);
  eq([s.profile.totalXp, s.currencyLedger.length, s.currencyLedger[0].relatedCompletionId], [50, 1, c.id]);
  await rejects(deleteQuest(db, q.id));
}));
test('a deleted quest stays deleted after reopening, and its history exports and re-imports', async () => {
  const name = 'life_rpg_del_' + Math.random().toString(36).slice(2);
  let db = await openDatabase(name);
  try {
    const q = await quest(db, { title: 'Gone', type: 'main' });
    await completeQuest(db, q.id);
    await deleteQuest(db, q.id);
    db.close(); db = await openDatabase(name);
    const s = await getState(db);
    eq([s.quests.length, s.completions.length, s.profile.totalXp], [0, 1, 10]);
    const backupText = JSON.stringify(await exportData(db));
    await importData(db, backupText);
    eq((await getState(db)).completions[0].questTitleSnapshot, 'Gone');
  } finally { db.close(); indexedDB.deleteDatabase(name); }
});

// ---- Phase 3: Gold engine
const bal = async (db) => goldBalance((await getState(db)).currencyLedger);
const rawLedgerAdd = (db, row) => new Promise((res, rej) => {
  const tx = db.transaction('currencyLedger', 'readwrite');
  tx.objectStore('currencyLedger').add(row);
  tx.oncomplete = res; tx.onerror = () => rej(tx.error);
});

test('Gold per effort tier is 5 / 10 / 25 / 50', () => {
  eq(['small', 'standard', 'meaningful', 'major'].map(goldForTier), [5, 10, 25, 50]);
  eq(GOLD_BY_TIER, { small: 5, standard: 10, meaningful: 25, major: 50 });
  for (const t of Object.keys(EFFORT_TIERS)) eq(goldForTier(t), xpForTier(t), 'matches XP');
});
test('goldAwardFor: eligible only, never in Rest mode', () => {
  const q = (o = {}) => ({ effortTier: 'meaningful', isGoldEligible: true, ...o });
  eq([goldAwardFor(q(), 'normal'), goldAwardFor(q(), 'gentle')], [25, 25]);
  eq([goldAwardFor(q({ isGoldEligible: false }), 'normal'), goldAwardFor(q(), 'rest')], [0, 0]);
});
test('completion writes XP, completion and Gold credit together for every tier', () => withDb(async (db) => {
  for (const [tier, gold] of [['small', 5], ['standard', 10], ['meaningful', 25], ['major', 50]]) {
    const q = await quest(db, { type: 'side', effortTier: tier, title: tier });
    const c = await completeQuest(db, q.id);
    eq([c.xpAwarded, c.goldAwarded, c.effortTier], [gold, gold, tier]);
  }
  const s = await getState(db);
  eq([s.profile.totalXp, goldBalance(s.currencyLedger), s.currencyLedger.length], [90, 90, 4]);
  for (const l of s.currencyLedger) ok(s.completions.some((c) => c.id === l.relatedCompletionId && c.goldAwarded === l.amount), 'every credit has its completion');
}));
test('Gold-ineligible quests award zero Gold but full XP', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main', effortTier: 'major', isGoldEligible: false });
  const c = await completeQuest(db, q.id);
  const s = await getState(db);
  eq([c.xpAwarded, c.goldAwarded, s.profile.totalXp, s.currencyLedger.length, goldBalance(s.currencyLedger)], [50, 0, 50, 0, 0]);
}));
test('Rest mode awards no Gold, XP continues, and leaving Rest changes nothing retroactively', () => withDb(async (db) => {
  await setDifficultyMode(db, 'rest');
  const q = await quest(db, { type: 'daily', effortTier: 'standard' });
  const c = await completeQuest(db, q.id, at(2026, 11, 26));
  eq([c.xpAwarded, c.goldAwarded], [10, 0]);
  await setDifficultyMode(db, 'normal');
  eq([(await getState(db)).profile.totalXp, await bal(db)], [10, 0]);
  eq((await completeQuest(db, q.id, at(2026, 11, 27))).goldAwarded, 10);
  eq(await bal(db), 10);
}));
test('balance is derived from the ledger and the profile has no balance field', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main', effortTier: 'standard' });
  await completeQuest(db, q.id);
  await rawLedgerAdd(db, { id: 'x1', amount: 7, reason: 'test credit', relatedCompletionId: null, relatedRedemptionId: null, createdAt: T, transactionKey: 'test:1' });
  eq(await bal(db), 17);
  const p = (await getState(db)).profile;
  ok(!Object.keys(p).some((k) => /gold|balance/i.test(k)), 'no stored balance');
}));
test('double-click: two simultaneous completions mint Gold once', () => withDb(async (db) => {
  const q = await quest(db, { type: 'daily', effortTier: 'meaningful' });
  const results = await Promise.allSettled([completeQuest(db, q.id, at(2026, 11, 26)), completeQuest(db, q.id, at(2026, 11, 26)), completeQuest(db, q.id, at(2026, 11, 26))]);
  eq(results.filter((r) => r.status === 'fulfilled').length, 1);
  ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.name === 'DuplicateCompletionError'), 'others rejected as duplicates');
  const s = await getState(db);
  eq([s.completions.length, s.currencyLedger.length, goldBalance(s.currencyLedger), s.profile.totalXp], [1, 1, 25, 25]);
}));
test('sequential repeat request cannot mint duplicate Gold', () => withDb(async (db) => {
  const q = await quest(db, { type: 'weekly', effortTier: 'major' });
  await completeQuest(db, q.id, at(2026, 11, 24));
  for (let i = 0; i < 3; i++) await rejects(completeQuest(db, q.id, at(2026, 11, 28)), 'DuplicateCompletionError');
  eq(await bal(db), 50);
}));
test('duplicate ledger key rolls back the whole completion (no completion without its Gold)', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main', effortTier: 'major' });
  await rawLedgerAdd(db, { id: 'pre', amount: 1, reason: 'collision', relatedCompletionId: null, relatedRedemptionId: null, createdAt: T, transactionKey: `completion:${q.id}:once` });
  await rejects(completeQuest(db, q.id), 'DuplicateCompletionError');
  const s = await getState(db);
  eq([s.completions.length, s.profile.totalXp, s.attributes.every((a) => a.totalXp === 0), s.quests[0].status, s.currencyLedger.length], [0, 0, true, 'active', 1]);
}));
test('failed completions never leave Gold behind', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main' });
  await changeQuestStatus(db, q.id, 'pause');
  await rejects(completeQuest(db, q.id));
  await rejects(completeQuest(db, 'missing'));
  eq([(await getState(db)).currencyLedger.length, (await getState(db)).completions.length], [0, 0]);
}));
test('XP is independent of Gold eligibility', () => withDb(async (db) => {
  const a = await quest(db, { type: 'side', title: 'A', effortTier: 'standard', isGoldEligible: true });
  const b = await quest(db, { type: 'side', title: 'B', effortTier: 'standard', isGoldEligible: false });
  const ca = await completeQuest(db, a.id), cb = await completeQuest(db, b.id);
  eq([ca.xpAwarded, cb.xpAwarded, ca.goldAwarded, cb.goldAwarded], [10, 10, 10, 0]);
}));
test('editing Gold eligibility affects future completions only', () => withDb(async (db) => {
  const q = await quest(db, { type: 'daily', effortTier: 'standard' });
  await completeQuest(db, q.id, at(2026, 11, 26));
  await updateQuest(db, q.id, { isGoldEligible: false });
  const next = await completeQuest(db, q.id, at(2026, 11, 27));
  const s = await getState(db);
  eq([next.goldAwarded, next.xpAwarded, await bal(db)], [0, 10, 10]);
  eq(s.completions.map((c) => c.goldAwarded).sort(), [0, 10]);
  await updateQuest(db, q.id, { isGoldEligible: true });
  eq((await getState(db)).completions.find((c) => c.periodKey === '2026-11-26').goldAwarded, 10, 'history untouched');
}));
test('quest management never creates Gold', () => withDb(async (db) => {
  const q = await quest(db, { type: 'daily' });
  await updateQuest(db, q.id, { title: 'Renamed', effortTier: 'major' });
  for (const a of ['pause', 'resume', 'archive', 'restore']) await changeQuestStatus(db, q.id, a);
  await deleteQuest(db, q.id);
  eq([(await getState(db)).currencyLedger.length, await bal(db)], [0, 0]);
}));
test('deleting a quest keeps its Gold credit and completion reference', () => withDb(async (db) => {
  const q = await quest(db, { title: 'Temp', type: 'main', effortTier: 'meaningful' });
  const c = await completeQuest(db, q.id);
  await deleteQuest(db, q.id);
  const s = await getState(db);
  eq([s.quests.length, goldBalance(s.currencyLedger), s.currencyLedger[0].relatedCompletionId, s.completions[0].questTitleSnapshot], [0, 25, c.id, 'Temp']);
}));
test('exported Gold history restores the exact balance; a completion without its credit is rejected', () => withDb(async (db) => {
  const q = await quest(db, { type: 'daily', effortTier: 'major' });
  await completeQuest(db, q.id, at(2026, 11, 26));
  const text = JSON.stringify(await exportData(db));
  const q2 = await quest(db, { type: 'main' }); await completeQuest(db, q2.id);
  eq(await bal(db), 60);
  await importData(db, text);
  eq(await bal(db), 50);
  const tampered = JSON.parse(text); tampered.data.currencyLedger = [];
  await rejects(importData(db, JSON.stringify(tampered)), 'BackupValidationError');
  eq(await bal(db), 50);
}));
test('migrated history gets no retroactive Gold', () => withLegacy(1, {}, {}, async (db) => {
  eq(await bal(db), 0);
  const c = await completeQuest(db, 'q1', at(2026, 11, 26));
  eq([c.goldAwarded, await bal(db)], [10, 10]);
}));

// ---- Phase 3: rewards, redemption, refunds
let earnN = 0;
const earn = async (db, tier = 'major') => completeQuest(db, (await quest(db, { type: 'side', effortTier: tier, title: 'earn' + earnN++ })).id);
const reward = (db, o = {}) => createReward(db, { title: 'Movie night', description: 'Popcorn included', goldCost: 30, ...o });
const R = async (db) => (await getState(db));

test('reward validation: title, whole positive cost, sane maximum', () => {
  eq(validateReward({ title: '  Coffee  ', description: '  nice ', goldCost: 20 }), { title: 'Coffee', description: 'nice', goldCost: 20 });
  eq(validateReward({ title: 'x', goldCost: 1 }).description, '');
  for (const bad of [{ title: '', goldCost: 5 }, { title: '   ', goldCost: 5 }, { title: 'x', goldCost: 0 }, { title: 'x', goldCost: -3 },
    { title: 'x', goldCost: 2.5 }, { title: 'x', goldCost: 100001 }, { title: 'x', goldCost: NaN }, { title: 'x', goldCost: '10' }, { title: 'x' },
    { title: 'x'.repeat(81), goldCost: 5 }, { title: 'x', goldCost: 5, description: 'y'.repeat(301) }]) {
    let threw = false; try { validateReward(bad); } catch { threw = true; }
    ok(threw, 'should reject ' + JSON.stringify(bad).slice(0, 60));
  }
  eq(validateReward({ title: 'x', goldCost: 100000 }).goldCost, 100000);
});
test('creating a reward stores a trimmed active reward; invalid input stores nothing', () => withDb(async (db) => {
  const r = await reward(db, { title: '  Pizza  ', goldCost: 40 });
  eq([r.title, r.goldCost, r.isActive, r.description], ['Pizza', 40, true, 'Popcorn included']);
  await rejects(reward(db, { goldCost: 0 })); await rejects(reward(db, { title: ' ' })); await rejects(reward(db, { goldCost: 1.5 }));
  eq((await R(db)).rewards.length, 1);
}));
test('editing a reward validates input and keeps the id', () => withDb(async (db) => {
  const r = await reward(db);
  const e = await updateReward(db, r.id, { title: 'Cinema trip', goldCost: 45 });
  eq([e.id, e.title, e.goldCost, e.description, e.isActive], [r.id, 'Cinema trip', 45, 'Popcorn included', true]);
  await rejects(updateReward(db, r.id, { goldCost: -1 })); await rejects(updateReward(db, r.id, { title: '' })); await rejects(updateReward(db, 'nope', { title: 'x' }));
  eq((await R(db)).rewards[0].goldCost, 45);
}));
test('redeeming debits Gold and records the redemption together', () => withDb(async (db) => {
  await earn(db, 'major');
  const r = await reward(db, { goldCost: 30 });
  const red = await redeemReward(db, r.id, { now: at(2026, 11, 26) });
  const s = await R(db);
  eq([red.goldSpent, red.status, red.rewardTitleSnapshot, red.rewardId], [30, 'redeemed', 'Movie night', r.id]);
  eq([goldBalance(s.currencyLedger), s.redemptions.length], [20, 1]);
  const debit = s.currencyLedger.find((l) => l.amount < 0);
  eq([debit.amount, debit.relatedRedemptionId, debit.transactionKey], [-30, red.id, 'redeem:' + red.id]);
}));
test('insufficient balance is rejected and nothing changes (no negative balance)', () => withDb(async (db) => {
  await earn(db, 'standard'); // 10 Gold
  const r = await reward(db, { goldCost: 30 });
  await rejects(redeemReward(db, r.id), 'InsufficientGoldError');
  const s = await R(db);
  eq([goldBalance(s.currencyLedger), s.redemptions.length, s.currencyLedger.length], [10, 0, 1]);
  const exact = await reward(db, { title: 'Exact', goldCost: 10 });
  await redeemReward(db, exact.id);
  eq(await bal(db), 0);
  await rejects(redeemReward(db, exact.id), 'InsufficientGoldError');
  eq(await bal(db), 0);
}));
test('concurrent redemptions cannot overspend', () => withDb(async (db) => {
  await earn(db, 'major'); // 50 Gold, reward costs 30: only one of three can succeed
  const r = await reward(db, { goldCost: 30 });
  const res = await Promise.allSettled([redeemReward(db, r.id), redeemReward(db, r.id), redeemReward(db, r.id)]);
  eq(res.filter((x) => x.status === 'fulfilled').length, 1);
  ok(res.filter((x) => x.status === 'rejected').every((x) => x.reason.name === 'InsufficientGoldError'), 'others: insufficient');
  const s = await R(db);
  eq([goldBalance(s.currencyLedger), s.redemptions.length], [20, 1]);
}));
test('a repeated request id is processed once (idempotent)', () => withDb(async (db) => {
  await earn(db, 'major'); await earn(db, 'major');
  const r = await reward(db, { goldCost: 30 });
  const res = await Promise.allSettled([redeemReward(db, r.id, { requestId: 'req-1' }), redeemReward(db, r.id, { requestId: 'req-1' })]);
  eq(res.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  eq(res.find((x) => x.status === 'rejected').reason.name, 'DuplicateRedemptionError');
  await rejects(redeemReward(db, r.id, { requestId: 'req-1' }), 'DuplicateRedemptionError');
  eq([await bal(db), (await R(db)).redemptions.length], [70, 1]);
}));
test('redemption rolls back completely if the debit cannot be written', () => withDb(async (db) => {
  await earn(db, 'major');
  const r = await reward(db, { goldCost: 30 });
  await rawLedgerAdd(db, { id: 'blocker', amount: 1, reason: 'collision', relatedCompletionId: null, relatedRedemptionId: null, createdAt: T, transactionKey: 'redeem:req-x' });
  await rejects(redeemReward(db, r.id, { requestId: 'req-x' }));
  const s = await R(db);
  eq([s.redemptions.length, goldBalance(s.currencyLedger), s.currencyLedger.length], [0, 51, 2]);
}));
test('archived rewards cannot be redeemed; restoring makes them redeemable again', () => withDb(async (db) => {
  await earn(db, 'major');
  const r = await reward(db, { goldCost: 20 });
  await setRewardActive(db, r.id, false);
  eq((await R(db)).rewards[0].isActive, false);
  await rejects(redeemReward(db, r.id));
  eq([await bal(db), (await R(db)).redemptions.length], [50, 0]);
  await setRewardActive(db, r.id, true);
  await redeemReward(db, r.id);
  eq(await bal(db), 30);
  await rejects(setRewardActive(db, 'nope', false));
}));
test('editing or archiving a reward never changes past redemptions', () => withDb(async (db) => {
  await earn(db, 'major');
  const r = await reward(db, { title: 'Movie night', goldCost: 30 });
  const red = await redeemReward(db, r.id);
  await updateReward(db, r.id, { title: 'Renamed', goldCost: 99 });
  await setRewardActive(db, r.id, false);
  const s = await R(db);
  eq([s.redemptions[0].rewardTitleSnapshot, s.redemptions[0].goldSpent, s.currencyLedger.find((l) => l.amount < 0).amount], ['Movie night', 30, -30]);
  eq(buildHistory(s).find((h) => h.kind === 'spent').title, 'Movie night');
  eq(red.id, s.redemptions[0].id);
}));
test('refund adds a compensating credit, keeps the original debit and updates the status', () => withDb(async (db) => {
  await completeQuest(db, (await quest(db, { type: 'side', effortTier: 'major' })).id, at(2026, 11, 25));
  const r = await reward(db, { goldCost: 30 });
  const red = await redeemReward(db, r.id, { now: at(2026, 11, 26, 10) });
  const debitBefore = JSON.stringify((await R(db)).currencyLedger.find((l) => l.amount < 0));
  const out = await refundRedemption(db, red.id, at(2026, 11, 26, 11));
  const s = await R(db);
  eq([out.status, s.redemptions[0].status, typeof s.redemptions[0].refundedAt], ['refunded', 'refunded', 'string']);
  eq([s.currencyLedger.length, goldBalance(s.currencyLedger)], [3, 50]);
  eq(JSON.stringify(s.currencyLedger.find((l) => l.amount < 0)), debitBefore, 'debit untouched');
  const credit = s.currencyLedger.find((l) => l.relatedRedemptionId === red.id && l.amount > 0);
  eq([credit.amount, credit.transactionKey], [30, 'refund:' + red.id]);
  eq(buildHistory(s).map((h) => h.kind), ['refund', 'spent', 'earned']);
}));
test('a redemption can be refunded only once, even with simultaneous requests', () => withDb(async (db) => {
  await earn(db, 'major');
  const r = await reward(db, { goldCost: 30 });
  const red = await redeemReward(db, r.id);
  const res = await Promise.allSettled([refundRedemption(db, red.id), refundRedemption(db, red.id), refundRedemption(db, red.id)]);
  eq(res.filter((x) => x.status === 'fulfilled').length, 1);
  ok(res.filter((x) => x.status === 'rejected').every((x) => x.reason.name === 'AlreadyRefundedError'), 'duplicates rejected');
  await rejects(refundRedemption(db, red.id), 'AlreadyRefundedError');
  await rejects(refundRedemption(db, 'nope'));
  eq([await bal(db), (await R(db)).currencyLedger.length], [50, 3]);
}));
test('refund is atomic: if the credit cannot be written the status stays redeemed', () => withDb(async (db) => {
  await earn(db, 'major');
  const r = await reward(db, { goldCost: 30 });
  const red = await redeemReward(db, r.id);
  await rawLedgerAdd(db, { id: 'blocker', amount: 1, reason: 'collision', relatedCompletionId: null, relatedRedemptionId: null, createdAt: T, transactionKey: 'refund:' + red.id });
  await rejects(refundRedemption(db, red.id));
  const s = await R(db);
  eq([s.redemptions[0].status, 'refundedAt' in s.redemptions[0], goldBalance(s.currencyLedger)], ['redeemed', false, 21]);
}));
test('after a refund the Gold can be spent again', () => withDb(async (db) => {
  await earn(db, 'major');
  const r = await reward(db, { goldCost: 50 });
  const a = await redeemReward(db, r.id);
  await rejects(redeemReward(db, r.id), 'InsufficientGoldError');
  await refundRedemption(db, a.id);
  await redeemReward(db, r.id);
  eq([await bal(db), (await R(db)).redemptions.map((x) => x.status).sort()], [0, ['redeemed', 'refunded']]);
}));
test('history lists earned, spent and refund rows newest first with snapshot titles', () => withDb(async (db) => {
  const q = await quest(db, { title: 'Run', type: 'main', effortTier: 'major' });
  await completeQuest(db, q.id, at(2026, 11, 20));
  const r = await reward(db, { title: 'Treat', goldCost: 20 });
  const red = await redeemReward(db, r.id, { now: at(2026, 11, 21) });
  await refundRedemption(db, red.id, at(2026, 11, 22));
  await deleteQuest(db, q.id);
  const h = buildHistory(await R(db));
  eq(h.map((x) => [x.kind, x.title, x.amount]), [['refund', 'Treat', 20], ['spent', 'Treat', -20], ['earned', 'Run', 50]]);
}));
test('backup of rewards, redemptions and refunds restores balances and statuses exactly', () => withDb(async (db) => {
  await earn(db, 'major'); await earn(db, 'major');
  const r = await reward(db, { goldCost: 30 });
  const a = await redeemReward(db, r.id);
  await redeemReward(db, r.id);
  await refundRedemption(db, a.id);
  const text = JSON.stringify(await exportData(db));
  const want = await bal(db);
  await earn(db, 'major');
  await importData(db, text);
  const s = await R(db);
  eq([await bal(db), want, s.redemptions.map((x) => x.status).sort()], [want, 70, ['redeemed', 'refunded']]);
  const bad = JSON.parse(text); bad.data.currencyLedger = bad.data.currencyLedger.filter((l) => l.amount > 0 || l.transactionKey.startsWith('refund:'));
  await rejects(importData(db, JSON.stringify(bad)), 'BackupValidationError'); // redemption lost its debit
  eq(await bal(db), want);
}));

// ---- Accounts (Supabase Auth, with a fake client: no network in tests)
const GOOD = { user: { id: 'u-1', email: 'daniel@example.com' }, expires_at: Math.floor(Date.now() / 1000) + 3600 };
function fakeClient(session = null) {
  const calls = [], listeners = [];
  const c = {
    calls, session,
    next: {},
    emit: (e, s) => listeners.forEach((f) => f(e, s)),
    auth: {
      onAuthStateChange(fn) { listeners.push(fn); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: c.session }, error: null }; },
      async signUp(a) { calls.push(['signUp', a]); return c.next.signUp ?? { data: { session: null, user: {} }, error: null }; },
      async signInWithPassword(a) { calls.push(['signIn', a]); const r = c.next.signIn ?? { data: { session: GOOD }, error: null }; if (r.data && r.data.session) c.session = r.data.session; return r; },
      async signOut(a) { calls.push(['signOut', a]); if (c.next.signOutThrows) throw new Error('Failed to fetch'); c.session = null; return { error: null }; },
      async resetPasswordForEmail(e, o) { calls.push(['reset', e, o]); return c.next.reset ?? { data: {}, error: null }; },
      async updateUser(a) { calls.push(['update', a]); return c.next.update ?? { data: { user: GOOD.user }, error: null }; },
    },
  };
  return c;
}
const mkAuth = async (client, extra = {}) => { const a = createAuth({ load: async () => client, redirectTo: 'https://example.test/app/', ...extra }); await a.init(); return a; };
const authErr = async (p) => { try { await p; } catch (e) { return e; } throw new Error('Expected AuthError'); };

test('sign-up validates input before touching the network', async () => {
  const c = fakeClient(), a = await mkAuth(c);
  for (const [email, pw] of [['not-an-email', 'longenough1'], ['', 'longenough1'], ['a@b.co', 'short'], ['a@b.co', '']]) {
    eq((await authErr(a.signUp(email, pw))).code, 'validation');
  }
  eq(c.calls.length, 0);
});
test('sign-up: confirmation-email flow keeps you signed out; instant-session flow signs you in', async () => {
  const c = fakeClient(), a = await mkAuth(c);
  eq(await a.signUp('  daniel@example.com ', 'longenough1'), { status: 'confirm_email' });
  eq(a.getState().status, 'signed_out');
  eq(c.calls[0][1], { email: 'daniel@example.com', password: 'longenough1', options: { emailRedirectTo: 'https://example.test/app/' } });
  c.next.signUp = { data: { session: GOOD, user: GOOD.user }, error: null };
  eq(await a.signUp('daniel@example.com', 'longenough1'), { status: 'signed_in' });
  eq([a.getState().status, a.getState().user.email], ['signed_in', 'daniel@example.com']);
});
test('sign-up errors are friendly (duplicate, weak password, offline, rate limit)', async () => {
  const c = fakeClient(), a = await mkAuth(c);
  for (const [msg, code] of [['User already registered', 'exists'], ['Password should be at least 6 characters', 'weak_password'], ['Failed to fetch', 'offline'], ['email rate limit exceeded', 'rate_limit']]) {
    c.next.signUp = { data: null, error: new Error(msg) };
    eq((await authErr(a.signUp('a@b.co', 'longenough1'))).code, code);
  }
  c.next.signUp = { data: null, error: Object.assign(new Error('x'), { name: 'AuthRetryableFetchError' }) };
  eq((await authErr(a.signUp('a@b.co', 'longenough1'))).code, 'offline');
});
test('login: success, wrong password, unconfirmed email, offline', async () => {
  const c = fakeClient(), a = await mkAuth(c);
  await a.signIn('daniel@example.com', 'longenough1');
  eq([a.getState().status, a.getState().user.id], ['signed_in', 'u-1']);
  const b = await mkAuth(fakeClient());
  const cb = b.getClient();
  for (const [msg, code, text] of [['Invalid login credentials', 'credentials', /do not match/], ['Email not confirmed', 'unconfirmed', /confirm your email/], ['Failed to fetch', 'offline', /safe on this device/]]) {
    cb.next.signIn = { data: { session: null }, error: new Error(msg) };
    const e = await authErr(b.signIn('daniel@example.com', 'whatever1'));
    ok(e.code === code && text.test(e.message), 'message for ' + code);
    eq(b.getState().status, 'signed_out');
  }
  eq((await authErr(b.signIn('bad', 'x'))).code, 'validation');
  eq((await authErr(b.signIn('a@b.co', ''))).code, 'validation');
});
test('logout is local, works offline, and never touches saved progress', () => withDb(async (db) => {
  const q = await quest(db, { type: 'main', effortTier: 'major' });
  await completeQuest(db, q.id);
  const before = JSON.stringify(await getState(db));
  const c = fakeClient(GOOD), a = await mkAuth(c);
  eq(a.getState().status, 'signed_in');
  await a.signOut();
  eq([a.getState().status, a.getState().user, c.calls[0]], ['signed_out', null, ['signOut', { scope: 'local' }]]);
  eq(a.getState().message, '', 'a deliberate sign-out is not shown as an error');
  eq(JSON.stringify(await getState(db)), before, 'progress untouched');
  const c2 = fakeClient(GOOD); c2.next.signOutThrows = true;
  const a2 = await mkAuth(c2); await a2.signOut();
  eq(a2.getState().status, 'signed_out');
}));
test('an unexpected sign-out explains itself and keeps progress', async () => {
  const c = fakeClient(GOOD), a = await mkAuth(c);
  c.emit('SIGNED_OUT', null);
  eq(a.getState().status, 'signed_out');
  ok(/progress is still on this device/.test(a.getState().message), 'reassuring message');
});
test('expired sessions are detected, refused for cloud use, and recover on refresh', async () => {
  const old = { ...GOOD, expires_at: Math.floor(Date.now() / 1000) - 10 };
  const c = fakeClient(old), a = await mkAuth(c);
  eq([a.getState().status, a.getState().expired], ['signed_in', true]);
  eq((await authErr(a.requireUser())).code, 'expired');
  c.session = GOOD; c.emit('TOKEN_REFRESHED', GOOD);
  eq(a.getState().expired, false);
  eq((await a.requireUser()).email, 'daniel@example.com');
  let clock = Date.now();
  const c2 = fakeClient(GOOD), a2 = await mkAuth(c2, { now: () => clock });
  clock += 2 * 3600 * 1000; await a2.refreshState();
  eq(a2.getState().expired, true);
});
test('unauthorized cloud access is rejected (signed out, or account features unavailable)', async () => {
  const a = await mkAuth(fakeClient());
  eq((await authErr(a.requireUser())).code, 'unauthorized');
  const down = createAuth({ load: async () => { throw new Error('offline'); } });
  await down.init();
  eq(down.getState().status, 'unavailable');
  eq((await authErr(down.requireUser())).code, 'unavailable');
  eq((await authErr(down.signIn('a@b.co', 'longenough1'))).code, 'unavailable');
  await down.signOut();
  eq(down.getState().status, 'signed_out');
});
test('password recovery: generic success, real problems surfaced, recovery event handled', async () => {
  const c = fakeClient(), a = await mkAuth(c);
  eq(await a.requestPasswordReset(' daniel@example.com '), { status: 'sent' });
  eq(c.calls[0], ['reset', 'daniel@example.com', { redirectTo: 'https://example.test/app/' }]);
  c.next.reset = { data: null, error: new Error('User not found') };
  eq(await a.requestPasswordReset('nobody@example.com'), { status: 'sent' }, 'does not reveal whether an account exists');
  c.next.reset = { data: null, error: new Error('Failed to fetch') };
  eq((await authErr(a.requestPasswordReset('a@b.co'))).code, 'offline');
  c.next.reset = { data: null, error: Object.assign(new Error('x'), { status: 429 }) };
  eq((await authErr(a.requestPasswordReset('a@b.co'))).code, 'rate_limit');
  eq((await authErr(a.requestPasswordReset('nope'))).code, 'validation');
  c.emit('PASSWORD_RECOVERY', GOOD);
  eq(a.getState().status, 'recovery');
  c.emit('SIGNED_IN', GOOD); c.emit('INITIAL_SESSION', GOOD);
  eq(a.getState().status, 'recovery', 'later events do not skip the new-password step');
  eq((await authErr(a.updatePassword('short'))).code, 'validation');
  c.session = GOOD;
  eq(await a.updatePassword('brandnewpass1'), { status: 'updated' });
  eq([a.getState().status, c.calls.at(-1)], ['signed_in', ['update', { password: 'brandnewpass1' }]]);
});
test('auth state changes notify subscribers and can be unsubscribed', async () => {
  const c = fakeClient(), a = await mkAuth(c), seen = [];
  const off = a.subscribe((st) => seen.push(st.status));
  c.emit('SIGNED_IN', GOOD); off(); c.emit('SIGNED_OUT', null);
  eq(seen, ['signed_in']);
});
test('error classification covers the common cases and hides internals', () => {
  eq(classify(new Error('Invalid login credentials')).code, 'credentials');
  eq(classify(new Error('NetworkError when attempting to fetch resource.')).code, 'offline');
  eq(classify(new Error('Load failed')).code, 'offline');
  eq(classify(new Error('relation "x" does not exist')), { code: 'other', message: 'Something went wrong. Please try again.' });
});

// ---- Runner
const list = document.getElementById('results');
let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  const li = document.createElement('li');
  try { await fn(); pass++; li.className = 'pass'; li.textContent = 'PASS  ' + name; }
  catch (e) { fail++; li.className = 'fail'; li.textContent = 'FAIL  ' + name; const pre = document.createElement('pre'); pre.textContent = e.message; li.append(pre); }
  list.append(li);
}
document.getElementById('summary').textContent = `${pass} passed, ${fail} failed, ${tests.length} total`;
document.title = (fail ? 'FAIL ' : 'PASS ') + document.title;
