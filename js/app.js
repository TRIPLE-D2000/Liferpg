// State coordination and event wiring.
import { openDatabase, getState, createQuest, updateQuest, changeQuestStatus, deleteQuest, completeQuest, setDifficultyMode, setWeeklyTarget, exportData, importData, DuplicateCompletionError } from './db.js';
import { levelFromXp, localDayKey } from './gameLogic.js';
import * as ui from './ui.js';

let db;
const state = { screen: 'home', filter: 'all', showAnyway: false, expanded: new Set(), editId: null, data: null };
const $ = (id) => document.getElementById(id);

async function refresh() {
  state.data = await getState(db);
  ui.setAttributeOptions(state.data.attributes);
  render();
}
function render() {
  const s = { ...state.data, now: new Date() };
  ui.renderHome(s, { filter: state.filter, showAnyway: state.showAnyway, expanded: state.expanded,
    onFilter, onComplete, onNew, onEdit, onStatus, onDelete, onExpand, onToggleRest });
  ui.renderProfile(s, { onMode, onTarget, onExport, onImport });
  ui.showScreen(state.screen);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { ui.toast(e.message || 'Something went wrong.', true); } };

function onFilter(f) { state.filter = f; render(); }
function onExpand(id) { state.expanded.add(id); render(); }
function onToggleRest() { state.showAnyway = !state.showAnyway; render(); }

const onComplete = guard(async (q) => {
  if (!(await ui.confirmDialog('Complete this quest?', `"${q.title}" will award ${q.xpReward} XP.`, 'Complete'))) return;
  const before = levelFromXp(state.data.profile.totalXp);
  try { await completeQuest(db, q.id); }
  catch (e) { if (e instanceof DuplicateCompletionError) { ui.toast('Already completed for this period.'); await refresh(); return; } throw e; }
  await refresh();
  const after = levelFromXp(state.data.profile.totalXp);
  ui.toast(after > before ? `Level up! You reached level ${after}.` : `+${q.xpReward} XP earned.`);
});

function openQuestDialog(q) {
  const d = $('quest-dialog'), f = $('quest-form');
  state.editId = q ? q.id : null;
  f.reset();
  if (q) {
    f.title.value = q.title; f.finishCondition.value = q.finishCondition || ''; f.type.value = q.type;
    f.attributeId.value = q.attributeId; f.effortTier.value = q.effortTier; f.isGoldEligible.checked = q.isGoldEligible !== false;
  }
  $('quest-dialog-title').textContent = q ? 'Edit quest' : 'New quest';
  $('quest-submit').textContent = q ? 'Save changes' : 'Create quest';
  d.returnValue = '';
  d.showModal();
}
const onNew = () => openQuestDialog(null);
const onEdit = (q) => openQuestDialog(q);

const STATUS_TOAST = { pause: 'Quest paused.', resume: 'Quest resumed.', archive: 'Quest archived.', restore: 'Quest restored.' };
const onStatus = guard(async (q, action) => {
  await changeQuestStatus(db, q.id, action);
  await refresh();
  ui.toast(STATUS_TOAST[action]);
});

const onDelete = guard(async (q) => {
  const ok = await ui.confirmDialog('Delete this quest permanently?',
    `"${q.title}" will be permanently removed from your quests. Your completion history, XP and Gold records are kept. This cannot be undone.`, 'Delete quest');
  if (!ok) return;
  await deleteQuest(db, q.id);
  state.expanded.delete(q.id);
  await refresh();
  ui.toast('Quest deleted. Your history is kept.');
});

const onMode = guard(async (m) => { await setDifficultyMode(db, m); state.showAnyway = false; await refresh(); });
const onTarget = guard(async (n) => { await setWeeklyTarget(db, n); await refresh(); ui.toast('Weekly target updated.'); });

const onExport = guard(async () => {
  const blob = new Blob([JSON.stringify(await exportData(db), null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `life-rpg-backup-${localDayKey()}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
  ui.toast('Backup exported.');
});

const onImport = () => $('import-file').click();

async function init() {
  ui.fillQuestForm();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.screen = b.dataset.screen; render(); }));

  $('quest-dialog').addEventListener('close', guard(async (e) => {
    if (e.target.returnValue !== 'ok') return;
    const f = $('quest-form');
    const fields = { title: f.title.value, finishCondition: f.finishCondition.value, type: f.type.value, attributeId: f.attributeId.value,
      effortTier: f.effortTier.value, isGoldEligible: f.isGoldEligible.checked };
    if (state.editId) { await updateQuest(db, state.editId, fields); await refresh(); ui.toast('Quest updated. Past completions are unchanged.'); }
    else { await createQuest(db, fields); await refresh(); ui.toast('Quest created.'); }
  }));

  const input = $('import-file');
  input.addEventListener('change', guard(async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (!(await ui.confirmDialog('Replace all progress?', 'Importing replaces your current quests, XP and history with the file contents.', 'Import'))) return;
    await importData(db, await file.text());
    await refresh();
    ui.toast('Backup imported.');
  }));

  try { db = await openDatabase(); await refresh(); }
  catch (e) { ui.toast('Storage is unavailable in this browser: ' + e.message, true); }
}
init();
