// State coordination and event wiring.
import { openDatabase, getState, createQuest, completeQuest, setDifficultyMode, exportData, importData, DuplicateCompletionError } from './db.js';
import { levelFromXp, localDayKey } from './gameLogic.js';
import * as ui from './ui.js';

let db;
const state = { screen: 'home', filter: 'all', data: null };

async function refresh() {
  state.data = await getState(db);
  ui.setAttributeOptions(state.data.attributes);
  render();
}
function render() {
  const s = { ...state.data, now: new Date() };
  ui.renderHome(s, { filter: state.filter, onFilter, onComplete, onNew });
  ui.renderProfile(s, { onMode, onExport, onImport });
  ui.showScreen(state.screen);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { ui.toast(e.message || 'Something went wrong.', true); } };

function onFilter(f) { state.filter = f; render(); }

const onComplete = guard(async (q) => {
  if (!(await ui.confirmDialog('Complete this quest?', `"${q.title}" will award ${q.xpReward} XP.`, 'Complete'))) return;
  const before = levelFromXp(state.data.profile.totalXp);
  try { await completeQuest(db, q.id); }
  catch (e) { if (e instanceof DuplicateCompletionError) { ui.toast('Already completed for this period.'); await refresh(); return; } throw e; }
  await refresh();
  const after = levelFromXp(state.data.profile.totalXp);
  ui.toast(after > before ? `Level up! You reached level ${after}.` : `+${q.xpReward} XP earned.`);
});

function onNew() {
  const d = document.getElementById('quest-dialog');
  d.querySelector('form').reset();
  d.returnValue = '';
  d.showModal();
}

const onMode = guard(async (m) => { await setDifficultyMode(db, m); await refresh(); });

const onExport = guard(async () => {
  const blob = new Blob([JSON.stringify(await exportData(db), null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `life-rpg-backup-${localDayKey()}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
  ui.toast('Backup exported.');
});

const onImport = () => document.getElementById('import-file').click();

async function init() {
  ui.fillQuestForm();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { state.screen = b.dataset.screen; render(); }));

  document.getElementById('quest-dialog').addEventListener('close', guard(async (e) => {
    if (e.target.returnValue !== 'ok') return;
    const f = document.getElementById('quest-form');
    await createQuest(db, { title: f.title.value, finishCondition: f.finishCondition.value, type: f.type.value, attributeId: f.attributeId.value, effortTier: f.effortTier.value });
    await refresh();
    ui.toast('Quest created.');
  }));

  const input = document.getElementById('import-file');
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
