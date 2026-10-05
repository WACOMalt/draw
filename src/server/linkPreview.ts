// Link previews: what Discord, X/Twitter, Slack, Mastodon, iMessage and others show for a link.
//
// - /s/CODE and /e/CODE pages get Open Graph and Twitter Card tags (title, description, image)
//   and an oEmbed link, in the HTML the server sends (crawlers do not run JavaScript).
// - GET /api/canvases/CODE/preview.png: the newest preview image, which an editor's browser
//   renders and sends over the WebSocket (session.ts takePreview). The server cannot render.
// - GET /api/oembed?url=...: a "rich" oEmbed answer with the live embed (/e/CODE) as an iframe,
//   for sites that embed through oEmbed (directly or with Iframely: Notion, Medium, ...).
//
// A crawler has no account and no cookie, so it gets what the link itself grants: the plain
// code of a public or view-only canvas, or a ?k= token. A private link, or a canvas with a join
// password, shows a generic card with no image and no owner.

import type http from 'node:http';
import { parseKey, PREVIEW_LIMITS } from '../shared/types';
import { isTemporary, resolveAccess, TEMP_TTL_MS } from './access';
import type { CanvasRow, Role, Store } from './db';

export interface LinkPreviewContext {
  store: Store;
  /** Public origin without a trailing slash, e.g. https://draw.bsums.xyz */
  publicUrl: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Canvas key from /s/KEY or /e/KEY, or null. */
export function keyFromPath(pathname: string): { key: string; embed: boolean } | null {
  const m = /^\/([se])\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try {
    const key = parseKey(decodeURIComponent(m[2]));
    return key ? { key, embed: m[1] === 'e' } : null;
  } catch {
    return null;
  }
}

/** The role the link alone gives (no account, no password), or null. */
async function linkAccess(store: Store, row: CanvasRow, k: string | null): Promise<Role | null> {
  const a = await resolveAccess(store, row, { link: k ?? undefined });
  return a.ok ? a.role : null;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

const titleFor = (key: string) => (/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key) ? `Drawing ${key}` : key);

interface Card {
  title: string;
  description: string;
  image: { url: string; width: number; height: number } | null;
  author: string | null;
  /** World frame of the preview image: x,y,w,h. */
  frame: string | null;
  /** The link gives no access: a generic card. */
  private: boolean;
}

/** A frame "x,y,w,h" of four finite numbers with w, h > 0, or null. */
function validFrame(r: string | null): string | null {
  const n = (r ?? '').split(',').map(Number);
  return n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? n.join(',') : null;
}

async function cardFor(ctx: LinkPreviewContext, key: string, k: string | null): Promise<Card | null> {
  const { store, publicUrl } = ctx;
  const row = store.canvas(key);
  if (!row) return null;
  const role = await linkAccess(store, row, k);
  if (!role) {
    return {
      title: 'A private drawing',
      description: row.join_password ? 'This drawing on Draw needs a password. Open the link to enter it.' : 'This drawing on Draw is private. Open the link and log in to see it.',
      image: null,
      author: null,
      frame: null,
      private: true,
    };
  }
  const owner = row.owner_id ? (store.userById(row.owner_id)?.name ?? null) : null;
  const how = role === 'viewer' ? 'Open the link to watch it live.' : 'Open the link to draw on it together, live.';
  let description: string;
  if (isTemporary(row)) {
    const left = row.created_at + TEMP_TTL_MS - Date.now();
    description = `A temporary live drawing. ${how} It is deleted in ${Math.max(1, Math.round(left / 86_400_000))} days unless someone keeps it.`;
  } else description = `A live drawing${owner ? ` by ${owner}` : ''}. ${how} Changed ${ago(Date.now() - row.last_active_at)}.`;
  const info = store.previewInfo(key);
  const image = info
    ? {
        url: `${publicUrl}/api/canvases/${encodeURIComponent(key)}/preview.png?v=${info.seq}${k ? `&k=${encodeURIComponent(k)}` : ''}`,
        width: PREVIEW_LIMITS.width,
        height: PREVIEW_LIMITS.height,
      }
    : null;
  return { title: titleFor(key), description, image, author: owner, frame: info?.frame ?? null, private: false };
}

/**
 * The app shell for /s/KEY and /e/KEY with the link preview tags. `html` is the built
 * index.html. Unknown canvases get the shell unchanged.
 */
export async function pageWithTags(ctx: LinkPreviewContext, html: string, pathname: string, search: URLSearchParams): Promise<string> {
  const at = keyFromPath(pathname);
  if (!at) return html;
  const k = search.get('k');
  const card = await cardFor(ctx, at.key, k);
  if (!card) return html;
  const pageUrl = `${ctx.publicUrl}${pathname}${k ? `?k=${encodeURIComponent(k)}` : ''}`;
  const image = card.image ?? { url: `${ctx.publicUrl}/icons/icon-512.png`, width: 512, height: 512 };
  const tags = [
    `<meta property="og:site_name" content="Draw" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(card.title)}" />`,
    `<meta property="og:description" content="${esc(card.description)}" />`,
    `<meta property="og:url" content="${esc(pageUrl)}" />`,
    `<meta property="og:image" content="${esc(image.url)}" />`,
    `<meta property="og:image:width" content="${image.width}" />`,
    `<meta property="og:image:height" content="${image.height}" />`,
    `<meta property="og:image:alt" content="${esc(card.image ? `The drawing ${card.title}` : 'Draw')}" />`,
    `<meta name="twitter:card" content="${card.image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(card.title)}" />`,
    `<meta name="twitter:description" content="${esc(card.description)}" />`,
    `<meta name="twitter:image" content="${esc(image.url)}" />`,
    `<link rel="alternate" type="application/json+oembed" href="${esc(`${ctx.publicUrl}/api/oembed?format=json&url=${encodeURIComponent(pageUrl)}`)}" title="${esc(card.title)}" />`,
  ].join('\n    ');
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(card.title)} · Draw</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(card.description)}" />`)
    .replace('</head>', `    ${tags}\n  </head>`);
}

/** GET /api/canvases/KEY/preview.png?k=... */
export async function previewImage(ctx: LinkPreviewContext, req: http.IncomingMessage, res: http.ServerResponse, key: string, k: string | null): Promise<void> {
  const row = ctx.store.canvas(key);
  const png = row && (await linkAccess(ctx.store, row, k)) ? ctx.store.previewPng(key) : undefined;
  if (!png) return void res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('not found');
  // The address carries ?v=<seq>: a new preview has a new address, so caching is safe.
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=600' });
  res.end(req.method === 'HEAD' ? undefined : png);
}

/** GET /api/oembed?url=...&maxwidth=&maxheight= (JSON only). */
export async function oembed(ctx: LinkPreviewContext, search: URLSearchParams): Promise<{ status: number; body: unknown }> {
  if ((search.get('format') ?? 'json') !== 'json') return { status: 501, body: { error: 'json_only' } };
  let target: URL;
  try {
    target = new URL(search.get('url') ?? '');
  } catch {
    return { status: 404, body: { error: 'not_found' } };
  }
  if (target.origin !== new URL(ctx.publicUrl).origin) return { status: 404, body: { error: 'not_found' } };
  const at = keyFromPath(target.pathname);
  if (!at) return { status: 404, body: { error: 'not_found' } };
  const k = target.searchParams.get('k');
  const card = await cardFor(ctx, at.key, k);
  if (!card) return { status: 404, body: { error: 'not_found' } };
  if (card.private) return { status: 401, body: { error: 'private' } };
  // Frame: an /e/ link's own, else the preview image's, else a default around the origin.
  const frame = (at.embed && validFrame(target.searchParams.get('r'))) || card.frame || '-640,-360,1280,720';
  const [, , fw, fh] = frame.split(',').map(Number);
  const aspect = fw > 0 && fh > 0 ? fw / fh : 16 / 9;
  const maxW = Number(search.get('maxwidth')) || 800;
  const maxH = Number(search.get('maxheight')) || Infinity;
  let width = Math.min(800, maxW);
  let height = Math.round(width / aspect);
  if (height > maxH) {
    height = Math.round(maxH);
    width = Math.round(height * aspect);
  }
  const src = `${ctx.publicUrl}/e/${encodeURIComponent(at.key)}?${k ? `k=${encodeURIComponent(k)}&` : ''}r=${frame}`;
  return {
    status: 200,
    body: {
      version: '1.0',
      type: 'rich',
      provider_name: 'Draw',
      provider_url: ctx.publicUrl,
      title: card.title,
      ...(card.author ? { author_name: card.author } : {}),
      html: `<iframe src="${esc(src)}" title="${esc(`${card.title} on Draw`)}" width="${width}" height="${height}" style="border:0;border-radius:8px" loading="lazy" allow="fullscreen"></iframe>`,
      width,
      height,
      ...(card.image ? { thumbnail_url: card.image.url, thumbnail_width: card.image.width, thumbnail_height: card.image.height } : {}),
      cache_age: 600,
    },
  };
}
