const root = document.querySelector('#app');
let state = null;
let requestId = crypto.randomUUID();
let retaking = false;
let flash = '';

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state?.csrf ?? '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

function points(n) {
  const last = n % 10;
  const word = n % 100 >= 11 && n % 100 <= 14 ? 'баллов' : last === 1 ? 'балл' : last >= 2 && last <= 4 ? 'балла' : 'баллов';
  return `${n} ${word}`;
}

function codeBlock(snippet) {
  const code = h('code');
  snippet.split('___').forEach((part, i, all) => {
    code.append(part);
    if (i < all.length - 1) code.append(h('span', { class: 'blank', 'aria-label': 'пропуск' }, '___'));
  });
  return h('pre', { class: 'code' }, code);
}

function questionCard(q, i, total) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, `Вопрос ${i + 1} из ${total}`),
      h('span', { class: 'tag' }, q.topic),
      h('span', { class: 'pts' }, points(q.weight))),
    codeBlock(q.snippet),
    h('label', { for: `a-${q.id}` }, q.prompt),
    h('input', { type: 'text', id: `a-${q.id}`, name: q.id, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '60', required: true }));
}

function resultView(a) {
  const sent = a.status === 'sent';
  return h('section', { class: 'result', 'aria-live': 'polite' },
    h('p', { class: 'score' }, h('strong', {}, String(a.score)), `из ${a.max}`),
    h('p', { class: `status ${sent ? 'ok' : 'bad'}` },
      sent ? 'Оценка отправлена в журнал Moodle.' : `Оценку не удалось отправить в Moodle: ${a.error || 'неизвестная ошибка'}`),
    h('ul', { class: 'marks' }, a.details.map((d, i) =>
      h('li', {}, `Вопрос ${i + 1}: `, h('b', { class: d.correct ? 'ok' : 'bad' }, d.correct ? 'верно' : 'неверно'), ` (${d.correct ? d.weight : 0} из ${d.weight})`))),
    sent
      ? h('button', { class: 'secondary', type: 'button', onclick: newAttempt }, 'Пройти ещё раз')
      : h('button', { class: 'primary', type: 'button', onclick: retry }, 'Отправить в Moodle ещё раз'));
}

function newAttempt() {
  requestId = crypto.randomUUID();
  retaking = true;
  flash = '';
  draw();
}

async function retry(ev) {
  ev.target.disabled = true;
  try {
    state.attempt = (await api('/api/retry', {})).attempt;
    flash = '';
  } catch (e) {
    flash = e.message;
  }
  draw();
}

async function onSubmit(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  button.textContent = 'Проверяем и отправляем…';
  const answers = Object.fromEntries(state.questions.map((q) => [q.id, form.elements[q.id].value]));
  try {
    state.attempt = (await api('/api/submit', { requestId, answers })).attempt;
    retaking = false;
    flash = '';
  } catch (e) {
    flash = e.message;
  }
  draw();
}

function draw() {
  const canSend = state.learner && state.gradebook;
  const parts = [
    h('h1', {}, 'Основы вёрстки: HTML и CSS'),
    h('p', { class: 'lead' }, 'Три коротких вопроса. Ответ — одно слово или короткая запись, регистр не важен. Максимум — 10 баллов.'),
  ];
  if (state.name) parts.push(h('p', { class: 'who' }, `Вы вошли как ${state.name}`));
  if (flash) parts.push(h('p', { class: 'notice', role: 'alert' }, flash));
  if (!state.learner) parts.push(h('p', { class: 'notice info' }, 'Вы открыли инструмент не как студент: оценка в журнал не отправляется.'));
  else if (!state.gradebook) parts.push(h('p', { class: 'notice' }, 'У этого элемента курса нет строки в журнале. Включите приём оценок в настройках инструмента (см. README).'));

  if (state.attempt && !retaking) {
    parts.push(resultView(state.attempt));
  } else {
    const form = h('form', { onsubmit: onSubmit, novalidate: false },
      state.questions.map((q, i) => questionCard(q, i, state.questions.length)),
      h('button', { class: 'primary', type: 'submit', disabled: !canSend }, 'Проверить и отправить в Moodle'));
    parts.push(form);
  }
  root.replaceChildren(...parts);
}

try {
  state = await api('/api/state');
  draw();
} catch (e) {
  root.replaceChildren(h('p', { class: 'notice', role: 'alert' }, e.message));
}
