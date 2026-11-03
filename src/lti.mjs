import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  generateKeyPair,
  exportJWK,
  importJWK,
  calculateJwkThumbprint,
} from 'jose';
import { randomId, buildScoreUrl } from './util.mjs';

export class LtiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
const AGS_CLAIM = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
export const SCOPE_SCORE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';

/** Ключ инструмента хранится в MongoDB, чтобы переживать перезапуски Render. */
export async function loadOrCreateKeys(db) {
  const col = db.collection('keys');
  let doc = await col.findOne({ _id: 'tool' });
  if (!doc) {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true, modulusLength: 2048 });
    const pub = await exportJWK(publicKey);
    const priv = await exportJWK(privateKey);
    const kid = await calculateJwkThumbprint(pub);
    doc = {
      _id: 'tool',
      kid,
      pub: { ...pub, kid, alg: 'RS256', use: 'sig' },
      priv: { ...priv, kid, alg: 'RS256' },
      createdAt: new Date(),
    };
    try {
      await col.insertOne(doc);
    } catch {
      doc = await col.findOne({ _id: 'tool' }); // ключ успел создать другой процесс
    }
  }
  return { kid: doc.kid, publicJwk: doc.pub, privateKey: await importJWK(doc.priv, 'RS256') };
}

export function createLti({ config, db, keys }) {
  const p = config.platform;
  const redirectUri = `${config.publicUrl}/lti/launch`;
  const jwks = createRemoteJWKSet(new URL(p.jwksUrl));

  async function accessToken(scope) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
      .setIssuer(p.clientId)
      .setSubject(p.clientId)
      .setAudience(p.tokenUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomId())
      .sign(keys.privateKey);
    const res = await fetch(p.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        scope,
      }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new LtiError(`Moodle не выдал токен (${res.status}). ${text}`, 502);
    }
    return (await res.json()).access_token;
  }

  return {
    /** Шаг 1: Moodle вызывает /lti/login, мы отправляем студента на авторизацию в Moodle. */
    async startLogin(params) {
      if (params.iss !== p.issuer) throw new LtiError('Неизвестная платформа: iss не совпадает с MOODLE_ISSUER');
      if (params.client_id && params.client_id !== p.clientId) throw new LtiError('client_id не совпадает с MOODLE_CLIENT_ID');
      if (params.lti_deployment_id && params.lti_deployment_id !== p.deploymentId) {
        throw new LtiError('deployment_id не совпадает с MOODLE_DEPLOYMENT_ID');
      }
      if (!params.login_hint) throw new LtiError('В запросе нет login_hint');

      const state = randomId();
      const nonce = randomId();
      await db.collection('states').insertOne({ _id: state, nonce, createdAt: new Date() });

      const query = {
        scope: 'openid',
        response_type: 'id_token',
        response_mode: 'form_post',
        prompt: 'none',
        client_id: p.clientId,
        redirect_uri: redirectUri,
        login_hint: params.login_hint,
        state,
        nonce,
      };
      if (params.lti_message_hint) query.lti_message_hint = params.lti_message_hint;
      const url = new URL(p.authUrl);
      url.search = new URLSearchParams(query).toString();
      return url.toString();
    },

    /** Шаг 2: Moodle присылает id_token на /lti/launch, проверяем подпись и claims. */
    async verifyLaunch(idToken, state) {
      const saved = await db.collection('states').findOneAndDelete({ _id: state });
      if (!saved) throw new LtiError('Неизвестный или уже использованный state. Откройте элемент в Moodle заново.');

      let payload;
      try {
        ({ payload } = await jwtVerify(idToken, jwks, {
          issuer: p.issuer,
          audience: p.clientId,
          algorithms: ['RS256'],
          clockTolerance: 30,
        }));
      } catch (e) {
        console.error('id_token:', e.message);
        throw new LtiError('Подпись или срок действия id_token не прошли проверку.');
      }
      if (payload.nonce !== saved.nonce) throw new LtiError('nonce не совпадает');
      if (payload[CLAIM + 'message_type'] !== 'LtiResourceLinkRequest') throw new LtiError('Ожидался LtiResourceLinkRequest');
      if (payload[CLAIM + 'version'] !== '1.3.0') throw new LtiError('Ожидалась версия LTI 1.3.0');
      if (payload[CLAIM + 'deployment_id'] !== p.deploymentId) throw new LtiError('deployment_id не совпадает');
      if (!payload.sub) throw new LtiError('В id_token нет sub');

      const ags = payload[AGS_CLAIM] || {};
      const scopes = Array.isArray(ags.scope) ? ags.scope : [];
      return {
        sub: payload.sub,
        name: payload.name || '',
        roles: payload[CLAIM + 'roles'] || [],
        userKey: [
          payload.iss,
          payload[CLAIM + 'deployment_id'],
          payload[CLAIM + 'context']?.id ?? '',
          payload[CLAIM + 'resource_link']?.id ?? '',
          payload.sub,
        ].join('|'),
        lineitem: ags.lineitem && scopes.includes(SCOPE_SCORE) ? ags.lineitem : null,
      };
    },

    /** Шаг 3: отправка оценки в журнал Moodle (AGS, score). */
    async sendScore({ lineitem, userId, score, max }) {
      const token = await accessToken(SCOPE_SCORE);
      const res = await fetch(buildScoreUrl(lineitem), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/vnd.ims.lis.v1.score+json',
        },
        body: JSON.stringify({
          userId,
          scoreGiven: score,
          scoreMaximum: max,
          activityProgress: 'Completed',
          gradingProgress: 'FullyGraded',
          timestamp: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new LtiError(`Moodle не принял оценку (${res.status}). ${text}`, 502);
      }
    },
  };
}
