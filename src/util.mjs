import crypto from 'node:crypto';

export function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Приводит ответ к виду для сравнения: без регистра, пробелов и обрамляющих символов. */
export function normalizeAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[<>"'`;=]/g, '');
}

/** Роль студента в запуске LTI. */
export function isLearner(roles = []) {
  return roles.some((r) => /#Learner$|\/Learner(#|$)|#Student$/.test(r));
}

/** Адрес для отправки оценки: .../lineitem?x=1 -> .../lineitem/scores?x=1 */
export function buildScoreUrl(lineitemUrl) {
  const u = new URL(lineitemUrl);
  u.pathname = u.pathname.replace(/\/+$/, '') + '/scores';
  return u.toString();
}
