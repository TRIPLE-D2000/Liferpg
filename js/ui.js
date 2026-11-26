// DOM rendering only. Text is always inserted as text nodes (no innerHTML).
import { EFFORT_TIERS, QUEST_TYPES, RECURRING, MODES, levelProgress, periodKeyFor, formatLocal, prepareBoard, weeklyConsistency, goldBalance } from './gameLogic.js';

const $ = (s) => document.querySelector(s);

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((x) => x != null));
  return n;
}

const bar = (pct, mini) => el('div', { class: 'bar' + (mini ? ' mini' : '') }, el('div', { class: 'fill', style: `width:${pct}%` }));

export function showScreen(name) {
  for (const s of ['home', 'profile']) $(`#screen-${s}`).hidden = s !== name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.screen === name));
}

let toastTimer;
export function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = isError ? 'err' : ''; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

export function confirmDialog(title, body, okLabel = 'Confirm') {
  const d = $('#confirm-dialog');
  d.querySelector('h3').textContent = title;
  d.querySelector('p').textContent = body;
  d.querySelector('[value=ok]').textContent = okLabel;
  return new Promise((res) => {
    d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true });
    d.returnValue = 'cancel';
    d.showModal();
  });
}

export function fillQuestForm() {
  const f = $('#quest-form');
  const opts = (sel, pairs) => sel.replaceChildren(...pairs.map(([v, t]) => el('option', { value: v }, t)));
  opts(f.type, Object.entries(QUEST_TYPES));
  opts(f.effortTier, Object.entries(EFFORT_TIERS).map(([k, t]) => [k, `${t.label} (${t.xp} XP)`]));
}
export function setAttributeOptions(attributes) {
  $('#quest-form').attributeId.replaceChildren(...attributes.map((a) => el('option', { value: a.id }, a.name)));
}

const act = (label, fn, cls = '') => el('button', { class: ('sm ' + cls).trim(), onclick: fn }, label);
const MODE_LABEL = (m) => m[0].toUpperCase() + m.slice(1);

export function renderHome(s, h) {
  const root = $('#screen-home');
  const mode = s.profile.difficultyMode;
  const lp = levelProgress(s.profile.totalXp);
  const attrName = Object.fromEntries(s.attributes.map((a) => [a.id, a.name]));
  const board = prepareBoard(s.quests, mode, { filter: h.filter, showAnyway: h.showAnyway, expanded: h.expanded });
  const wc = weeklyConsistency(s.completions, s.now, s.profile.weeklyTargetDays);
  const badges = (q) => el('div', { class: 'badges' },
    el('span', { class: 'badge' }, QUEST_TYPES[q.type]),
    el('span', { class: 'badge' }, attrName[q.attributeId] || q.attributeId),
    el('span', { class: 'badge xp' }, `+${q.xpReward} XP`));

  const card = ({ quest: q, collapsed }) => {
    if (collapsed) {
      return el('article', { class: 'quest soft' }, el('h3', {}, q.title),
        el('div', { class: 'badges' }, el('span', { class: 'badge' }, EFFORT_TIERS[q.effortTier].label)),
        act('Show quest', () => h.onExpand(q.id)));
    }
    const done = RECURRING.has(q.type) && s.completions.some((c) => c.questId === q.id && c.periodKey === periodKeyFor(q.type, s.now));
    return el('article', { class: 'quest' },
      el('h3', {}, q.title),
      q.finishCondition ? el('p', {}, q.finishCondition) : null,
      badges(q),
      el('button', { class: 'primary', disabled: done, onclick: () => h.onComplete(q) }, done ? (q.type === 'daily' ? 'Done today' : 'Done this week') : 'Complete'),
      el('div', { class: 'actions' },
        act('Edit', () => h.onEdit(q)), act('Pause', () => h.onStatus(q, 'pause')),
        act('Archive', () => h.onStatus(q, 'archive')), act('Delete quest', () => h.onDelete(q), 'danger')));
  };

  const list = (title, quests, buttons) => (quests.length
    ? el('details', { class: 'manage' }, el('summary', {}, `${title} (${quests.length})`),
      ...quests.map((q) => el('div', { class: 'mrow' }, el('span', {}, q.title), el('div', { class: 'actions' }, ...buttons(q)))))
    : null);
  const withStatus = (st) => s.quests.filter((q) => q.status === st).sort((a, b) => a.title.localeCompare(b.title));
  const del = (q) => act('Delete quest', () => h.onDelete(q), 'danger');

  const boardNodes = [];
  if (board.resting) {
    boardNodes.push(el('div', { class: 'rest' },
      el('p', {}, 'Rest is part of the schedule. No quests required today.'),
      act(h.showAnyway ? 'Hide quests' : 'View quests anyway', h.onToggleRest)));
  }
  if (board.items.length) boardNodes.push(...board.items.map(card));
  else if (!board.resting) boardNodes.push(el('p', { class: 'empty' }, 'No quests here yet. Create one to start earning XP.'));
  else if (h.showAnyway) boardNodes.push(el('p', { class: 'empty' }, 'No active quests to show.'));

  // Optional sections are null when empty; filter them out (replaceChildren would print "null").
  root.replaceChildren(...[
    el('div', { class: 'hero' },
      el('p', { class: 'lvl' }, `Level ${lp.level}`),
      el('p', { class: 'sub' }, `${lp.into} of ${lp.span} XP to level ${lp.level + 1}. Total ${s.profile.totalXp} XP.`),
      bar(lp.pct),
      el('p', { class: 'sub' }, `${goldBalance(s.currencyLedger)} Gold`)),
    el('div', { class: 'week' },
      el('b', {}, `${wc.count} / ${wc.target} active days this week`),
      el('div', { class: 'dots' }, wc.days.map((d, i) => el('span', { class: 'dot' + (d.active ? ' on' : '') + (d.today ? ' today' : ''), title: d.key }, 'MTWTFSS'[i]))),
      bar(wc.pct, true),
      el('p', { class: 'sub' }, wc.message)),
    el('h2', {}, 'Attributes'),
    el('div', { class: 'attrs' }, s.attributes.map((a) => {
      const ap = levelProgress(a.totalXp);
      return el('div', { class: 'attr' }, el('b', {}, a.name), el('span', {}, `${a.totalXp} XP`), bar(ap.pct, true));
    })),
    el('h2', {}, `Quest board${mode === 'normal' ? '' : ' (' + MODE_LABEL(mode) + ' mode)'}`),
    el('div', { class: 'chips' }, [['all', 'All'], ...Object.entries(QUEST_TYPES)].map(([k, t]) =>
      el('button', { 'aria-pressed': String(h.filter === k), onclick: () => h.onFilter(k) }, t))),
    ...boardNodes,
    el('button', { class: 'primary new', onclick: h.onNew }, 'New quest'),
    list('Paused quests', withStatus('paused'), (q) => [act('Resume', () => h.onStatus(q, 'resume')), act('Archive', () => h.onStatus(q, 'archive')), del(q)]),
    list('Completed quests', withStatus('completed'), (q) => [act('Archive', () => h.onStatus(q, 'archive')), del(q)]),
    list('Archived quests', withStatus('archived'), (q) => [act('Restore', () => h.onStatus(q, 'restore')), del(q)]),
  ].filter(Boolean));
}

export function renderProfile(s, h) {
  const root = $('#screen-profile');
  const attrName = Object.fromEntries(s.attributes.map((a) => [a.id, a.name]));
  const history = [...s.completions].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  root.replaceChildren(
    el('h2', {}, 'Mode'),
    el('div', { class: 'modes' }, MODES.map((m) =>
      el('button', { 'aria-pressed': String(s.profile.difficultyMode === m), onclick: () => h.onMode(m) }, MODE_LABEL(m)))),
    el('p', { class: 'sub' }, 'Normal shows everything. Gentle puts small tasks first. Rest hides the board and pauses Gold.'),
    el('h2', {}, 'Weekly target'),
    el('select', { class: 'inline', 'aria-label': 'Active days per week', onchange: (e) => h.onTarget(Number(e.target.value)) },
      [1, 2, 3, 4, 5, 6, 7].map((n) => el('option', { value: String(n), selected: n === s.profile.weeklyTargetDays }, `${n} active ${n === 1 ? 'day' : 'days'} per week`))),
    el('h2', {}, 'Data backup'),
    el('div', { class: 'data-actions' },
      el('button', { onclick: h.onExport }, 'Export JSON'),
      el('button', { onclick: h.onImport }, 'Import JSON')),
    el('h2', {}, 'Completion history'),
    history.length
      ? el('ul', { class: 'log' }, history.map((c) => el('li', {},
        el('div', {}, el('b', {}, c.questTitleSnapshot), el('br'), el('small', {}, `${attrName[c.attributeId] || c.attributeId}, ${formatLocal(c.completedAt)}`)),
        el('span', { class: 'gain' }, `+${c.xpAwarded} XP` + (c.goldAwarded > 0 ? `, +${c.goldAwarded} Gold` : '')))))
      : el('p', { class: 'empty' }, 'Nothing completed yet. Finished quests will appear here.'));
}
