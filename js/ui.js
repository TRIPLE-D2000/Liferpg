// DOM rendering only. Text is always inserted as text nodes (no innerHTML).
import { EFFORT_TIERS, QUEST_TYPES, RECURRING, MODES, levelProgress, periodKeyFor, formatLocal } from './gameLogic.js';

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

export function renderHome(s, h) {
  const root = $('#screen-home');
  const lp = levelProgress(s.profile.totalXp);
  const attrName = Object.fromEntries(s.attributes.map((a) => [a.id, a.name]));
  const order = Object.keys(QUEST_TYPES);
  const quests = s.quests
    .filter((q) => q.status === 'active' && (h.filter === 'all' || q.type === h.filter))
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.createdAt.localeCompare(b.createdAt));

  const card = (q) => {
    const done = RECURRING.has(q.type) && s.completions.some((c) => c.questId === q.id && c.periodKey === periodKeyFor(q.type, s.now));
    return el('article', { class: 'quest' },
      el('h3', {}, q.title),
      q.finishCondition ? el('p', {}, q.finishCondition) : null,
      el('div', { class: 'badges' },
        el('span', { class: 'badge' }, QUEST_TYPES[q.type]),
        el('span', { class: 'badge' }, attrName[q.attributeId] || q.attributeId),
        el('span', { class: 'badge xp' }, `+${q.xpReward} XP`)),
      el('button', { class: 'primary', disabled: done, onclick: () => h.onComplete(q) }, done ? (q.type === 'daily' ? 'Done today' : 'Done this week') : 'Complete'));
  };

  root.replaceChildren(
    el('div', { class: 'hero' },
      el('p', { class: 'lvl' }, `Level ${lp.level}`),
      el('p', { class: 'sub' }, `${lp.into} of ${lp.span} XP to level ${lp.level + 1}. Total ${s.profile.totalXp} XP.`),
      bar(lp.pct)),
    el('h2', {}, 'Attributes'),
    el('div', { class: 'attrs' }, s.attributes.map((a) => {
      const ap = levelProgress(a.totalXp);
      return el('div', { class: 'attr' }, el('b', {}, a.name), el('span', {}, `${a.totalXp} XP`), bar(ap.pct, true));
    })),
    el('h2', {}, 'Quest board'),
    el('div', { class: 'chips' }, [['all', 'All'], ...Object.entries(QUEST_TYPES)].map(([k, t]) =>
      el('button', { 'aria-pressed': String(h.filter === k), onclick: () => h.onFilter(k) }, t))),
    quests.length ? quests.map(card) : el('p', { class: 'empty' }, 'No quests here yet. Create one to start earning XP.'),
    el('button', { class: 'primary new', onclick: h.onNew }, 'New quest'));
}

export function renderProfile(s, h) {
  const root = $('#screen-profile');
  const attrName = Object.fromEntries(s.attributes.map((a) => [a.id, a.name]));
  const history = [...s.completions].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  root.replaceChildren(
    el('h2', {}, 'Mode'),
    el('div', { class: 'modes' }, MODES.map((m) =>
      el('button', { 'aria-pressed': String(s.profile.difficultyMode === m), onclick: () => h.onMode(m) }, m[0].toUpperCase() + m.slice(1)))),
    el('p', { class: 'sub' }, 'Modes are saved now and will change how quests behave in a later phase.'),
    el('h2', {}, 'Data backup'),
    el('div', { class: 'data-actions' },
      el('button', { onclick: h.onExport }, 'Export JSON'),
      el('button', { onclick: h.onImport }, 'Import JSON')),
    el('h2', {}, 'Completion history'),
    history.length
      ? el('ul', { class: 'log' }, history.map((c) => el('li', {},
        el('div', {}, el('b', {}, c.questTitleSnapshot), el('br'), el('small', {}, `${attrName[c.attributeId] || c.attributeId}, ${formatLocal(c.completedAt)}`)),
        el('span', { class: 'gain' }, `+${c.xpAwarded} XP`))))
      : el('p', { class: 'empty' }, 'Nothing completed yet. Finished quests will appear here.'));
}
