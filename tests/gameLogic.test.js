// Zero-dependency test runner. Serve the project over http (not file://) and open tests/test.html.
import { EFFORT_TIERS, xpForTier, xpForLevel, levelFromXp, localDayKey, localWeekKey, periodKeyFor } from '../js/gameLogic.js';
import { openDatabase, getState, createQuest, completeQuest, exportData, importData, restoreInTransaction, DuplicateCompletionError, BackupValidationError } from '../js/db.js';

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
  eq([b.app, b.schemaVersion, b.exportFormatVersion], ['life-rpg', 1, 1]);
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
