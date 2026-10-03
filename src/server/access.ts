// Who may do what on a canvas.
//
// Temporary canvas (no owner): anyone with the code edits. Only the creating browser may claim.
// Owned canvas, best role wins:
//   owner  > member role (added by email) > link role
//   link role: ?k=<edit token> -> editor, ?k=<view token> -> viewer
//              plain /s/CODE    -> code_role: 'viewer' (default), 'editor' (public) or 'none'
//   The code is in every link, so only a public canvas gives edit access by the code alone.
// A join password applies to link access only. After one correct entry the client keeps a
// signed grant, which stops working as soon as the owner changes or removes the password.

import crypto from 'node:crypto';
import { verifyPassword } from './auth';
import type { CanvasRow, Role, Store, UserRow } from './db';

export const TEMP_TTL_MS = Number(process.env.TEMP_TTL_MS ?? 5 * 24 * 3600 * 1000);

export interface AccessInput {
  user?: UserRow;
  /** ?k= token from the share link. */
  link?: string;
  /** sha256 of the browser's anonymous secret. */
  anonHash?: string;
  password?: string;
  grant?: string;
}

export type Access =
  | { ok: true; role: Role; grant?: string }
  | { ok: false; reason: 'no_access' | 'login_required' | 'password_required' | 'password_wrong' };

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export const atLeast = (role: Role | null | undefined, min: Role) => !!role && RANK[role] >= RANK[min];

function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function isTemporary(c: CanvasRow): boolean {
  return !c.owner_id && !c.legacy;
}

export function canClaim(c: CanvasRow, anonHash: string | undefined): boolean {
  return isTemporary(c) && safeEqual(c.creator_anon, anonHash);
}

function grantFor(store: Store, c: CanvasRow): string {
  return crypto.createHmac('sha256', store.secret('grant')).update(`${c.code}\n${c.join_password}`).digest('base64url');
}

/** Role from the link alone (no account involved). */
function linkRole(c: CanvasRow, link: string | undefined): Role | null {
  if (safeEqual(link, c.edit_token) || c.code_role === 'editor') return 'editor';
  if (safeEqual(link, c.view_token) || c.code_role === 'viewer') return 'viewer';
  return null;
}

export async function resolveAccess(store: Store, c: CanvasRow, input: AccessInput): Promise<Access> {
  if (!c.owner_id) return { ok: true, role: 'editor' }; // temporary or legacy canvas

  let best: Role | null = null;
  if (input.user?.id === c.owner_id) best = 'owner';
  else if (input.user) best = store.memberRole(c.code, input.user.id) ?? null;

  const viaLink = linkRole(c, input.link);
  if (viaLink && (!best || RANK[viaLink] > RANK[best])) {
    // Link access may need the join password; people with their own access never do.
    if (c.join_password) {
      if (safeEqual(input.grant, grantFor(store, c))) return { ok: true, role: viaLink };
      if (input.password !== undefined) {
        if (await verifyPassword(input.password, c.join_password)) return { ok: true, role: viaLink, grant: grantFor(store, c) };
        if (!best) return { ok: false, reason: 'password_wrong' };
      } else if (!best) return { ok: false, reason: 'password_required' };
    } else return { ok: true, role: viaLink };
  }
  if (best) return { ok: true, role: best };
  return { ok: false, reason: input.user ? 'no_access' : 'login_required' };
}

/** Same as resolveAccess, but never checks a typed password (no scrypt): for re-checks. */
export async function recheckAccess(store: Store, c: CanvasRow, input: AccessInput): Promise<Access> {
  return resolveAccess(store, c, { ...input, password: undefined });
}
