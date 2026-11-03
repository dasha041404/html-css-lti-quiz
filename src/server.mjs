import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, platformReady } from './config.mjs';
import { connect } from './db.mjs';
import { createLti, loadOrCreateKeys, LtiError } from './lti.mjs';
import { publicQuestions, grade, cleanAnswers } from './quiz.mjs';
import { parseCookies, randomId, isLearner, escapeHtml } from './util.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

if (!config.mongoUri) {
  console.error('Не задана переменная окружения MONGODB_URI');
  process.exit(1);
}

const { db } = await connect(config.mongoUri, config.dbName);
const keys = await loadOrCreateKeys(db);
const lti = platformReady() ? createLti({ config, db, keys }) : null;
const sessions = db.collection('sessions');
const attempts = db.collection('attempts');
const appOrigin = new URL(config.publicUrl).origin;
const secureCookie = config.publicUrl.startsWith('https://');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
      "frame-ancestors 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
});
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(express.json({ limit: '10kb' }));

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function page(title, body) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 1rem;color:#172033">
<h1 style="font-size:1.4rem">${escapeHtml(title)}</h1>${body}`;
}

// ---------- служебные страницы ----------
app.get('/healthz', (req, res) => res.json({ ok: true, registered: Boolean(lti) }));

app.get('/', (req, res) => {
  const row = (label, value) => `<tr><td style="padding:.25rem 1rem .25rem 0">${label}</td><td><code>${escapeHtml(value)}</code></td></tr>`;
  res.type('html').send(
    page(
      'Тренажёр по HTML и CSS (LTI 1.3)',
      `<p>Это инструмент для Moodle. Откройте его из курса.</p>
       <p>Значения для регистрации в Moodle:</p>
       <table>${row('Tool URL', config.publicUrl + '/lti/launch')}${row('Initiate login URL', config.publicUrl + '/lti/login')}
       ${row('Redirection URI', config.publicUrl + '/lti/launch')}${row('Public keyset', config.publicUrl + '/lti/keys')}</table>
       <p>Статус регистрации: ${lti ? 'готово' : 'нужно задать MOODLE_ISSUER, MOODLE_CLIENT_ID и MOODLE_DEPLOYMENT_ID'}.</p>`,
    ),
  );
});

app.get('/lti/keys', (req, res) => res.json({ keys: [keys.publicJwk] }));

// ---------- вход через LTI ----------
const login = ah(async (req, res) => {
  if (!lti) throw new LtiError('Инструмент ещё не зарегистрирован: задайте MOODLE_* переменные.', 503);
  const url = await lti.startLogin({ ...req.query, ...req.body });
  res.redirect(302, url);
});
app.get('/lti/login', login);
app.post('/lti/login', login);

app.post(
  '/lti/launch',
  ah(async (req, res) => {
    if (!lti) throw new LtiError('Инструмент ещё не зарегистрирован.', 503);
    const { id_token: idToken, state } = req.body;
    if (typeof idToken !== 'string' || typeof state !== 'string') throw new LtiError('В запросе нет id_token или state');

    const user = await lti.verifyLaunch(idToken, state);
    const sid = randomId();
    const maxAge = config.sessionMinutes * 60 * 1000;
    await sessions.insertOne({
      sid,
      csrf: randomId(),
      userKey: user.userKey,
      ltiUserId: user.sub,
      name: user.name,
      learner: isLearner(user.roles),
      lineitem: user.lineitem,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + maxAge),
    });
    res.cookie('sid', sid, { httpOnly: true, secure: secureCookie, sameSite: 'lax', maxAge, path: '/' });
    res.redirect(303, '/app');
  }),
);

// ---------- сессия ----------
app.use(
  ah(async (req, res, next) => {
    const sid = parseCookies(req.headers.cookie).sid;
    req.lti = sid ? await sessions.findOne({ sid, expiresAt: { $gt: new Date() } }) : null;
    next();
  }),
);

app.get('/app', (req, res) => {
  if (!req.lti) {
    return res.status(401).type('html').send(page('Нужен вход через Moodle', '<p>Откройте этот элемент из курса в Moodle под студентом. Сессия длится 45 минут.</p>'));
  }
  res.set('Cache-Control', 'no-store').sendFile(path.join(publicDir, 'app.html'));
});
app.use('/assets', express.static(path.join(publicDir, 'assets'), { maxAge: '1h' }));

function requireApi(req, res, next) {
  if (!req.lti) return res.status(401).json({ error: 'Сессия закончилась. Откройте элемент в Moodle заново.' });
  res.set('Cache-Control', 'no-store');
  if (req.method === 'POST') {
    const origin = req.get('origin');
    if (origin && origin !== appOrigin) return res.status(403).json({ error: 'Недопустимый Origin' });
    if (req.get('x-csrf-token') !== req.lti.csrf) return res.status(403).json({ error: 'Неверный CSRF-токен' });
  }
  next();
}

const toClient = (a) => a && {
  id: String(a._id),
  score: a.score,
  max: a.max,
  details: a.details,
  status: a.status,
  error: a.error,
  createdAt: a.createdAt,
};

async function deliver(attempt) {
  try {
    await lti.sendScore({ lineitem: attempt.lineitem, userId: attempt.ltiUserId, score: attempt.score, max: attempt.max });
    attempt.status = 'sent';
    attempt.error = null;
    attempt.sentAt = new Date();
  } catch (e) {
    console.error('AGS:', e.message);
    attempt.status = 'failed';
    attempt.error = e instanceof LtiError ? e.message : 'Moodle недоступен';
  }
  await attempts.updateOne({ _id: attempt._id }, { $set: { status: attempt.status, error: attempt.error, sentAt: attempt.sentAt ?? null } });
}

// ---------- API ----------
app.get(
  '/api/state',
  requireApi,
  ah(async (req, res) => {
    const last = await attempts.findOne({ userKey: req.lti.userKey }, { sort: { createdAt: -1 } });
    res.json({
      name: req.lti.name,
      learner: req.lti.learner,
      gradebook: Boolean(req.lti.lineitem),
      csrf: req.lti.csrf,
      questions: publicQuestions(),
      attempt: toClient(last),
    });
  }),
);

app.post(
  '/api/submit',
  requireApi,
  ah(async (req, res) => {
    const s = req.lti;
    if (!s.learner) return res.status(403).json({ error: 'Отправлять ответы может только студент.' });
    if (!s.lineitem) return res.status(409).json({ error: 'У элемента курса нет строки в журнале оценок. Проверьте настройки инструмента в Moodle.' });

    const { requestId, answers } = req.body ?? {};
    if (typeof requestId !== 'string' || !/^[\w-]{8,64}$/.test(requestId)) return res.status(400).json({ error: 'Некорректный requestId' });

    const same = await attempts.findOne({ userKey: s.userKey, requestId });
    if (same) return res.json({ attempt: toClient(same) });

    const unsent = await attempts.findOne({ userKey: s.userKey, status: { $ne: 'sent' } });
    if (unsent) return res.status(409).json({ error: 'Предыдущий результат ещё не отправлен в Moodle. Сначала отправьте его.' });

    const result = grade(answers);
    const attempt = {
      userKey: s.userKey,
      requestId,
      ltiUserId: s.ltiUserId,
      lineitem: s.lineitem,
      answers: cleanAnswers(answers),
      score: result.score,
      max: result.max,
      details: result.details,
      status: 'pending',
      error: null,
      createdAt: new Date(),
    };
    try {
      attempt._id = (await attempts.insertOne(attempt)).insertedId;
    } catch (e) {
      if (e.code === 11000) return res.json({ attempt: toClient(await attempts.findOne({ userKey: s.userKey, requestId })) });
      throw e;
    }
    await deliver(attempt);
    res.json({ attempt: toClient(attempt) });
  }),
);

app.post(
  '/api/retry',
  requireApi,
  ah(async (req, res) => {
    const attempt = await attempts.findOne({ userKey: req.lti.userKey, status: { $ne: 'sent' } }, { sort: { createdAt: -1 } });
    if (!attempt) return res.status(404).json({ error: 'Нет неотправленных результатов.' });
    await deliver(attempt);
    res.json({ attempt: toClient(attempt) });
  }),
);

// ---------- ошибки ----------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(err);
  const known = err instanceof LtiError;
  const status = known ? err.status : 500;
  const message = known ? err.message : 'Внутренняя ошибка сервера';
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).type('html').send(page('Не удалось открыть инструмент', `<p>${escapeHtml(message)}</p>`));
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Слушаю порт ${config.port}, PUBLIC_URL=${config.publicUrl}, LTI ${lti ? 'зарегистрирован' : 'не настроен'}`);
});
