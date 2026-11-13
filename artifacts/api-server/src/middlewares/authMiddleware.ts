import type { AuthUser } from '@workspace/api-zod';
import { type NextFunction, type Request, type Response } from 'express';
import * as oidc from 'openid-client';

import {
  clearSession,
  getOidcConfig,
  getSessionId,
  loadSession,
  SESSION_COOKIE,
  setSessionCookie,
  updateSession,
  type SessionData,
} from '../lib/auth';

declare global {
  namespace Express {
    interface User extends AuthUser {}

    interface Request {
      isAuthenticated(): this is AuthedRequest;

      user?: User | undefined;
    }

    export interface AuthedRequest {
      user: User;
    }
  }
}

/** Refreshes in progress, one per session, so requests that arrive together share it. */
const refreshing = new Map<string, Promise<void>>();

/**
 * Keeps Replit's sign-in tokens fresh, as a courtesy: OllieOS's own session (7 days, longer while in
 * use) is what decides whether Ollie is signed in, and nothing else uses these tokens.
 *
 * It used to sign Ollie out whenever a refresh failed. Pages ask for several things at once, so when
 * the token expired every request refreshed with the same one-use refresh token, all but the first
 * were refused, and the session was deleted: "Could not load" everywhere, then the sign-in page.
 * Now one refresh runs per session at a time, and a failed one leaves the session as it is.
 */
async function refreshIfExpired(sid: string, session: SessionData): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (!session.expires_at || now <= session.expires_at || !session.refresh_token) return;
  const running = refreshing.get(sid);
  if (running) return running;
  const job = (async () => {
    try {
      const config = await getOidcConfig();
      const tokens = await oidc.refreshTokenGrant(config, session.refresh_token!);
      session.access_token = tokens.access_token;
      session.refresh_token = tokens.refresh_token ?? session.refresh_token;
      session.expires_at = tokens.expiresIn() ? now + tokens.expiresIn()! : now + 3600;
    } catch {
      // Not a reason to sign out. Stop trying for an hour, so requests do not each wait on it.
      session.expires_at = now + 3600;
    }
    await updateSession(sid, session).catch(() => undefined);
  })().finally(() => refreshing.delete(sid));
  refreshing.set(sid, job);
  return job;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request['isAuthenticated'];

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  try {
    const loaded = await loadSession(sid);
    const session = loaded?.data;
    if (!session?.user?.id) {
      // Only a session that is gone or past its date signs Ollie out.
      await clearSession(res, sid);
      next();
      return;
    }
    await refreshIfExpired(sid, session);
    // Keep the browser's cookie in step with the session while it is in use.
    if (loaded!.extended && req.cookies?.[SESSION_COOKIE] === sid) setSessionCookie(res, sid);
    req.user = session.user;
    next();
  } catch (err) {
    // The database could not be reached: say so (a retry will work) rather than answering
    // "not signed in", which would send Ollie to the sign-in page.
    next(err);
  }
}
