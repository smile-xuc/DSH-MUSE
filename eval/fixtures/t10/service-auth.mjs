import { logEvent } from './logger.mjs';

export function authenticate(user, traceId = 'tr-auth-1') {
  if (!user) {
    const res = logEvent('warn', 'anonymous login attempt');
    return { ok: false, log: res };
  }
  const res = logEvent('info', `user ${user} logged in`);
  return { ok: true, user, log: res };
}
