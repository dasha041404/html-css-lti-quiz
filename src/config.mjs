const env = process.env;
const clean = (s) => String(s || '').trim().replace(/\/+$/, '');
const port = Number(env.PORT || 3000);
const issuer = clean(env.MOODLE_ISSUER);

export const config = {
  port,
  publicUrl: clean(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL) || `http://localhost:${port}`,
  mongoUri: String(env.MONGODB_URI || '').trim(),
  dbName: env.MONGODB_DB || 'lti_quiz',
  sessionMinutes: 45,
  platform: {
    issuer,
    clientId: String(env.MOODLE_CLIENT_ID || '').trim(),
    deploymentId: String(env.MOODLE_DEPLOYMENT_ID || '').trim(),
    authUrl: clean(env.MOODLE_AUTH_URL) || `${issuer}/mod/lti/auth.php`,
    tokenUrl: clean(env.MOODLE_TOKEN_URL) || `${issuer}/mod/lti/token.php`,
    jwksUrl: clean(env.MOODLE_JWKS_URL) || `${issuer}/mod/lti/certs.php`,
  },
};

export function platformReady(c = config) {
  return Boolean(c.platform.issuer && c.platform.clientId && c.platform.deploymentId);
}
