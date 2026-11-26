// Zero-dependency test runner. Serve the project over http (not file://) and open tests/test.html.
import { EFFORT_TIERS, xpForTier, xpForLevel, levelFromXp, localDayKey, localWeekKey, periodKeyFor, prepareBoard, weekDays, weeklyConsistency } from '../js/gameLogic.js';
import { openDatabase, getState, createQuest, completeQuest, updateQuest, changeQuestStatus, deleteQuest, setWeeklyTarget, setDifficultyMode, exportData, importData, restoreInTransaction, DuplicateCompletionError, BackupValidationError } from '../js/db.js';

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
  await new Promise((res, rej) => { // a ledger row that references the completion
    const tx = db.transaction('currencyLedger', 'readwrite');
    tx.objectStore('currencyLedger').add({ id: 'l1', amount: 50, reason: 'Quest completed', relatedCompletionId: c.id, relatedRedemptionId: null, createdAt: T, transactionKey: 'completion:' + c.id });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
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
