import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('비밀번호는 12~128자로 입력하세요.');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function config(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT는 1~65535 사이의 정수여야 합니다.');
  let defaultOrigin = `http://localhost:${port}`;
  let codespacesOrigin;
  if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    const name = env.CODESPACE_NAME, domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
    if (!/^[a-z0-9-]+$/i.test(name) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(domain)) throw Error('Codespaces 주소 환경 변수를 확인하세요.');
    defaultOrigin = `https://${name}-${port}.${domain}`;
    codespacesOrigin = defaultOrigin;
  }
  const configuredOrigin = env.APP_ORIGIN || defaultOrigin;
  const origin = new URL(configuredOrigin);
  const production = env.NODE_ENV === 'production';
  const railway = Boolean(env.RAILWAY_SERVICE_ID || env.RAILWAY_ENVIRONMENT_ID);
  if (!['http:','https:'].includes(origin.protocol) || origin.origin !== configuredOrigin) throw Error('APP_ORIGIN에는 경로 없는 정확한 HTTP(S) origin을 지정하세요.');
  if (production && (origin.protocol !== 'https:' || !env.APP_ORIGIN || !env.SITE_ID)) throw Error('운영 환경은 HTTPS APP_ORIGIN과 SITE_ID가 필요합니다.');
  if (production && (!env.DATABASE_PATH || !isAbsolute(env.DATABASE_PATH))) throw Error('운영 DATABASE_PATH는 영구 저장소의 절대 파일 경로여야 합니다.');
  const storageRoot = env.STORAGE_ROOT || (railway ? env.RAILWAY_VOLUME_MOUNT_PATH : null);
  if (production) {
    if (!storageRoot || !isAbsolute(storageRoot) || storageRoot === '/') throw Error('운영 STORAGE_ROOT는 영구 저장소의 절대 디렉터리 경로여야 합니다.');
    const within = relative(storageRoot, env.DATABASE_PATH);
    if (!within || within === '..' || within.startsWith('../') || isAbsolute(within)) throw Error('DATABASE_PATH는 STORAGE_ROOT 안에 있어야 합니다.');
  }
  if (railway) {
    if (!production) throw Error('Railway에서는 NODE_ENV=production이 필요합니다.');
    const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mount || !isAbsolute(mount) || mount === '/') throw Error('Railway 영구 볼륨을 연결하세요.');
    const path = relative(mount, env.DATABASE_PATH);
    if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) throw Error('DATABASE_PATH는 Railway 영구 볼륨 안에 있어야 합니다.');
    if (env.HOST && env.HOST !== '0.0.0.0') throw Error('Railway HOST는 0.0.0.0이어야 합니다.');
  }
  if (env.MAINTENANCE_MODE && !['0','1'].includes(env.MAINTENANCE_MODE)) throw Error('MAINTENANCE_MODE는 0 또는 1이어야 합니다.');
  return { origin: origin.origin, secure: production || origin.protocol === 'https:', siteId: env.SITE_ID || 'local-site', databasePath: env.DATABASE_PATH, production,
    port, host: env.HOST || '0.0.0.0', volumeMountPath: production ? storageRoot : null, maintenance: env.MAINTENANCE_MODE === '1',
    codespacesProxyOrigins: origin.origin === codespacesOrigin ? [`http://localhost:${port}`, `https://localhost:${port}`] : [] };
}

export function requestOriginAllowed(request, settings) {
  const origin = request.headers.get('origin');
  if (origin === settings.origin) return true;
  // Codespaces may rewrite Origin during port forwarding. Never trust that
  // loopback value alone: retain browser-controlled same-origin evidence.
  if (!settings.codespacesProxyOrigins?.includes(origin)) return false;
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return false;
  if (request.headers.get('x-onwork-origin') !== settings.origin) return false;
  try {
    return new URL(request.headers.get('referer')).origin === settings.origin;
  } catch { return false; }
}

export function originLabel(value) {
  if (!value) return '(없음)';
  if (value === 'null') return 'null';
  try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '(유효하지 않음)'; }
  catch { return '(유효하지 않음)'; }
}
