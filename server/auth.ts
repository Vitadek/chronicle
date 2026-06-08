import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db, LOCAL_USER_ID } from './db';
import { config } from './config';
import { parseTrustedProxies, matchesTrustedProxy } from './trust';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      sessionToken?: string;
      authVia?: 'none' | 'token' | 'forward' | 'oidc' | 'nextcloud';
    }
  }
}

// ----- Trusted-proxy CIDR list, parsed once at boot. -----
const trustedProxyCidrs = parseTrustedProxies(config.auth.forward.trustedProxies);

// ============================================================================
// Mode dispatcher
// ============================================================================

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  switch (config.auth.mode) {
    case 'none':
      req.userId = LOCAL_USER_ID;
      req.authVia = 'none';
      return next();
    case 'token':
      return tokenAuth(req, res, next);
    case 'forward':
      return forwardAuth(req, res, next);
    case 'oidc':
      return sessionAuth(req, res, next);
  }
}

// ============================================================================
// Mode: token (static bearer)
// ============================================================================

function tokenAuth(req: Request, res: Response, next: NextFunction): void {
  const t = bearerFromHeader(req);
  if (!t || !timingSafeEq(t, config.auth.token)) {
    res.status(401).json({ error: 'Invalid or missing token' });
    return;
  }
  req.userId = LOCAL_USER_ID;
  req.authVia = 'token';
  next();
}

// ============================================================================
// Mode: oidc (session-backed)
// ============================================================================

function sessionAuth(req: Request, res: Response, next: NextFunction): void {
  const t = bearerFromHeader(req);
  if (!t) {
    res.status(401).json({ error: 'Not authenticated', loginUrl: '/api/auth/oidc/start' });
    return;
  }
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
    .get(t) as { user_id: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) {
    res.status(401).json({ error: 'Session expired', loginUrl: '/api/auth/oidc/start' });
    return;
  }
  req.userId = row.user_id;
  req.sessionToken = t;
  req.authVia = 'oidc';
  next();
}

// ============================================================================
// Mode: forward (trusted proxy headers)
// ============================================================================

function forwardAuth(req: Request, res: Response, next: NextFunction): void {
  // 1. Verify the request actually came from a trusted proxy. We check the
  //    immediate TCP peer — NOT X-Forwarded-For, which is exactly what's
  //    being decided whether to trust.
  const peer = req.socket.remoteAddress;
  if (!matchesTrustedProxy(peer, trustedProxyCidrs)) {
    console.warn(`[auth/forward] rejected untrusted peer ${peer}`);
    res.status(403).json({ error: 'Untrusted proxy' });
    return;
  }

  // 2. Optional extra defense: shared secret header.
  if (config.auth.forward.sharedSecret) {
    const got = req.header(config.auth.forward.sharedSecretHeader || 'X-Forward-Auth-Secret') || '';
    if (!timingSafeEq(got, config.auth.forward.sharedSecret)) {
      res.status(403).json({ error: 'Missing or bad shared secret' });
      return;
    }
  }

  // 3. Pull identity from the configured headers.
  const username = req.header(config.auth.forward.headerUser);
  if (!username) {
    res.status(401).json({ error: 'No identity header from proxy' });
    return;
  }
  const email = req.header(config.auth.forward.headerEmail) || null;
  const displayName = req.header(config.auth.forward.headerName) || username;

  const userId = upsertExternalUser({
    provider: 'forward',
    issuer: 'proxy',
    externalId: username,
    email,
    displayName,
  });

  req.userId = userId;
  req.authVia = 'forward';
  next();
}

// ============================================================================
// Helpers
// ============================================================================

function bearerFromHeader(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Mint a new opaque session token, optionally with Nextcloud OAuth tokens. */
export function createSession(
  userId: string,
  nc?: { accessToken: string; refreshToken: string; expiresInSec: number },
): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + config.sessionTtlMs;

  db.prepare(
    `INSERT INTO sessions
       (token, user_id, nc_access_token, nc_refresh_token, nc_expires_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    userId,
    nc?.accessToken ?? null,
    nc?.refreshToken ?? null,
    nc ? now + nc.expiresInSec * 1000 : null,
    expiresAt,
    now,
  );

  return token;
}

export function revokeSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * Look up (and create if needed) a local user record for an external identity.
 *
 * Keyed on (provider, issuer, external_id) so the same external user always
 * maps to the same local user across logins, and the same external_id from
 * different providers stays distinct.
 */
export function upsertExternalUser(args: {
  provider: 'oidc' | 'forward';
  issuer: string;
  externalId: string;
  email?: string | null;
  displayName?: string | null;
}): string {
  const existing = db
    .prepare(
      `SELECT id FROM users
        WHERE external_provider = ? AND external_issuer = ? AND external_id = ?`,
    )
    .get(args.provider, args.issuer, args.externalId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE users
          SET display_name = COALESCE(?, display_name),
              email        = COALESCE(?, email)
        WHERE id = ?`,
    ).run(args.displayName ?? null, args.email ?? null, existing.id);
    return existing.id;
  }

  // Adopt-by-email: no match on (provider, issuer, external_id), but a user
  // with this email already exists — e.g. switching auth providers, or a
  // single-user deployment whose data lives under another id (LOCAL_USER_ID).
  // Bind this external identity to that user instead of inserting a duplicate
  // (which would also trip the UNIQUE email constraint).
  if (args.email) {
    const byEmail = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get(args.email) as { id: string } | undefined;
    if (byEmail) {
      db.prepare(
        `UPDATE users
            SET external_provider = ?, external_issuer = ?, external_id = ?,
                display_name = COALESCE(?, display_name)
          WHERE id = ?`,
      ).run(args.provider, args.issuer, args.externalId, args.displayName ?? null, byEmail.id);
      return byEmail.id;
    }
  }

  const id = crypto.randomBytes(12).toString('base64url');
  db.prepare(
    `INSERT INTO users
       (id, email, display_name, external_provider, external_issuer, external_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.email ?? null,
    args.displayName ?? args.externalId,
    args.provider,
    args.issuer,
    args.externalId,
    Date.now(),
  );
  return id;
}
