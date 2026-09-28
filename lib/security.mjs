import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
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
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:3000');
  const production = env.NODE_ENV === 'production';
  if (origin.origin !== (env.APP_ORIGIN || 'http://localhost:3000')) throw Error('APP_ORIGIN에는 경로 없는 정확한 origin을 지정하세요.');
  if (production && (origin.protocol !== 'https:' || !env.APP_ORIGIN || !env.SITE_ID)) throw Error('운영 환경은 HTTPS APP_ORIGIN과 SITE_ID가 필요합니다.');
  return { origin: origin.origin, secure: production || origin.protocol === 'https:', siteId: env.SITE_ID || 'local-site', databasePath: env.DATABASE_PATH, production };
}
