// State coordination and event wiring.
import { openDatabase, getState, createQuest, updateQuest, changeQuestStatus, deleteQuest, completeQuest, setDifficultyMode, setWeeklyTarget, exportData, importData, createReward, updateReward, setRewardActive, redeemReward, refundRedemption, DuplicateCompletionError } from './db.js';
import { levelFromXp, localDayKey, goldAwardFor } from './gameLogic.js';
import * as ui from './ui.js';

let db;
const inFlight = new Set();
const state = { screen: 'home', filter: 'all', showAnyway: false, expanded: new Set(), editId: null, editRewardId: null, data: null };
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
  ui.renderRewards(s, { onNewReward, onEditReward, onArchiveReward, onRestoreReward, onRedeem, onRefund });
  ui.renderProfile(s, { onMode, onTarget, onExport, onImport });
  ui.showScreen(state.screen);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { ui.toast(e.message || 'Something went wrong.', true); } };

function onFilter(f) { state.filter = f; render(); }
function onExpand(id) { state.expanded.add(id); render(); }
function onToggleRest() { state.showAnyway = !state.showAnyway; render(); }

const onComplete = guard(async (q) => {
  if (inFlight.has(q.id)) return; // the database also blocks duplicates; this just avoids a pointless second request
  const gold = goldAwardFor(q, state.data.profile.difficultyMode);
  if (!(await ui.confirmDialog('Complete this quest?', `"${q.title}" will award ${q.xpReward} XP${gold ? ` and ${gold} Gold` : ''}.`, 'Complete'))) return;
  inFlight.add(q.id);
  const before = levelFromXp(state.data.profile.totalXp);
  let done;
  try { done = await completeQuest(db, q.id); }
  catch (e) { if (e instanceof DuplicateCompletionError) { ui.toast('Already completed for this period.'); await refresh(); return; } throw e; }
  finally { inFlight.delete(q.id); }
  await refresh();
  const after = levelFromXp(state.data.profile.totalXp);
  const earned = `+${done.xpAwarded} XP${done.goldAwarded ? `, +${done.goldAwarded} Gold` : ''}`;
  ui.toast(after > before ? `Level up! You reached level ${after}. ${earned}` : `${earned} earned.`);
});

function openQuestDialog(q) {
  const d = $('quest-dialog'), f = $('quest-form');
  state.editId = q ? q.id : null;
  f.reset();
  if (q) {
    f.elements.title.value = q.title; f.elements.finishCondition.value = q.finishCondition || ''; f.elements.type.value = q.type;
    f.elements.attributeId.value = q.attributeId; f.elements.effortTier.value = q.effortTier; f.elements.isGoldEligible.checked = q.isGoldEligible !== false;
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

// ---- Rewards
const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function openRewardDialog(r) {
  const d = $('reward-dialog'), f = $('reward-form');
  state.editRewardId = r ? r.id : null;
  f.reset();
  if (r) { f.elements.title.value = r.title; f.elements.description.value = r.description || ''; f.elements.goldCost.value = String(r.goldCost); }
  $('reward-dialog-title').textContent = r ? 'Edit reward' : 'New reward';
  $('reward-submit').textContent = r ? 'Save changes' : 'Create reward';
  d.returnValue = '';
  d.showModal();
}
const onNewReward = () => openRewardDialog(null);
const onEditReward = (r) => openRewardDialog(r);

const onArchiveReward = guard(async (r) => { await setRewardActive(db, r.id, false); await refresh(); ui.toast('Reward archived. Past redemptions are kept.'); });
const onRestoreReward = guard(async (r) => { await setRewardActive(db, r.id, true); await refresh(); ui.toast('Reward restored.'); });

const onRedeem = guard(async (r, balance) => {
  const key = 'redeem:' + r.id;
  if (inFlight.has(key)) return;
  const ok = await ui.confirmDialog('Redeem this reward?', `"${r.title}" costs ${r.goldCost} Gold. You have ${balance} Gold, leaving ${balance - r.goldCost}.`, 'Redeem');
  if (!ok) return;
  inFlight.add(key);
  try { await redeemReward(db, r.id, { requestId: newRequestId() }); }
  catch (e) { await refresh(); throw e; } // the database re-checks everything; show its answer and resync the screen
  finally { inFlight.delete(key); }
  await refresh();
  ui.toast(`Redeemed "${r.title}". Enjoy it.`);
});

const onRefund = guard(async (redemptionId, title, gold) => {
  const ok = await ui.confirmDialog('Refund this redemption?', `You will get ${gold} Gold back for "${title}". The original purchase stays in your history.`, 'Refund');
  if (!ok) return;
  try { await refundRedemption(db, redemptionId); }
  catch (e) { await refresh(); throw e; }
  await refresh();
  ui.toast(`Refunded ${gold} Gold.`);
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
    const fields = { title: f.elements.title.value, finishCondition: f.elements.finishCondition.value, type: f.elements.type.value, attributeId: f.elements.attributeId.value,
      effortTier: f.elements.effortTier.value, isGoldEligible: f.elements.isGoldEligible.checked };
    if (state.editId) { await updateQuest(db, state.editId, fields); await refresh(); ui.toast('Quest updated. Past completions are unchanged.'); }
    else { await createQuest(db, fields); await refresh(); ui.toast('Quest created.'); }
  }));

  $('reward-dialog').addEventListener('close', guard(async (e) => {
    if (e.target.returnValue !== 'ok') return;
    const f = $('reward-form');
    const fields = { title: f.elements.title.value, description: f.elements.description.value, goldCost: f.elements.goldCost.value === '' ? NaN : Number(f.elements.goldCost.value) };
    if (state.editRewardId) { await updateReward(db, state.editRewardId, fields); await refresh(); ui.toast('Reward updated. Past redemptions are unchanged.'); }
    else { await createReward(db, fields); await refresh(); ui.toast('Reward created.'); }
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
