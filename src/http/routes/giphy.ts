import { Router } from 'express';
import { config } from '../../config.js';
import type { AppContext } from '../../context.js';
import { isValidAttachment } from '../../lib/attachments.js';
import { TokenBucketRateLimiter } from '../../lib/rateLimiter.js';
import { AppError, errors } from '../../types.js';
import { asyncHandler, principalOf, requireAuth } from '../middleware.js';

const GIPHY_API = 'https://api.giphy.com/v1/gifs';

/** What the picker needs, and nothing else. */
export interface GifResult {
  id: string;
  /** Full-size still-animated GIF, sent as the attachment. */
  url: string;
  width: number;
  height: number;
  /** Smaller variant used in the picker grid so a search isn't 24 full GIFs. */
  previewUrl: string;
  title: string;
}

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}

export interface GiphyGif {
  id?: string;
  title?: string;
  images?: Record<string, GiphyImage | undefined>;
}

/** First variant that actually has a usable url, in descending preference. */
function pickImage(gif: GiphyGif, names: string[]): GiphyImage | null {
  for (const name of names) {
    const image = gif.images?.[name];
    if (image?.url) return image;
  }
  return null;
}

/**
 * Maps one upstream result, or null if it is unusable. Every candidate is run
 * through the same allowlist that `message.send` applies, so the picker can
 * never show a GIF that would be rejected on send.
 */
export function toResult(gif: GiphyGif): GifResult | null {
  if (!gif.id) return null;

  const full = pickImage(gif, ['fixed_width', 'downsized', 'fixed_height', 'original']);
  const preview = pickImage(gif, [
    'fixed_width_downsampled',
    'preview_gif',
    'fixed_height_downsampled',
  ]);
  if (!full?.url) return null;

  const candidate = {
    kind: 'gif' as const,
    url: full.url,
    width: Number(full.width),
    height: Number(full.height),
    alt: gif.title ?? '',
  };
  if (!isValidAttachment(candidate)) return null;

  // The preview is only ever an <img src> in the picker, but it is rendered by
  // the same browsers, so hold it to the same standard.
  const previewUrl =
    preview?.url && isValidAttachment({ ...candidate, url: preview.url })
      ? preview.url
      : candidate.url;

  return {
    id: gif.id,
    url: candidate.url,
    width: candidate.width,
    height: candidate.height,
    previewUrl,
    title: (gif.title ?? '').trim().slice(0, 200),
  };
}

async function fetchGifs(path: 'search' | 'trending', query: string): Promise<GifResult[]> {
  const url = new URL(`${GIPHY_API}/${path}`);
  url.searchParams.set('api_key', config.giphy.apiKey);
  url.searchParams.set('limit', String(config.giphy.resultLimit));
  url.searchParams.set('rating', config.giphy.rating);
  // Trims the response to the variants a chat client actually renders.
  url.searchParams.set('bundle', 'messaging_non_clips');
  if (path === 'search') url.searchParams.set('q', query);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.giphy.timeoutMs),
    });
  } catch (err) {
    // Includes the timeout. Never surface the URL — it carries the api_key.
    console.error(`[giphy] ${path} request failed:`, err instanceof Error ? err.message : err);
    throw new AppError('upstream_unavailable', 'GIF search is temporarily unavailable', 503);
  }

  if (!response.ok) {
    console.error(`[giphy] ${path} returned HTTP ${response.status}`);
    throw errors.invalid('GIF search failed');
  }

  const payload = (await response.json().catch(() => ({}))) as { data?: GiphyGif[] };
  if (!Array.isArray(payload.data)) return [];

  return payload.data.map(toResult).filter((gif): gif is GifResult => gif !== null);
}

/**
 * Server-side proxy for the Giphy API. Exists so the API key never reaches the
 * browser, and so results are normalised and allowlist-checked before a client
 * ever sees them.
 */
export function giphyRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  const searches = new TokenBucketRateLimiter(
    config.giphyRateLimit.burst,
    config.giphyRateLimit.refillPerSecond,
  );

  const enabled = config.giphy.apiKey !== '';

  /** Lets the client hide the GIF button when the server has no key. */
  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      res.json({ enabled });
    }),
  );

  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      if (!enabled) throw errors.notFound('GIF search is not configured on this server');

      // Keyed by user, not IP: colleagues behind one office NAT should not
      // share a search budget.
      const decision = searches.consume(`user:${principalOf(req).userId}`);
      if (!decision.allowed) {
        throw errors.rateLimited(
          `Too many searches. Try again in ${Math.ceil(decision.retryAfterMs / 1000)}s`,
        );
      }

      const raw = req.query.q;
      const query = typeof raw === 'string' ? raw.trim().slice(0, 100) : '';

      // An empty query means "show me something" — trending, not an error.
      const gifs = query === '' ? await fetchGifs('trending', '') : await fetchGifs('search', query);
      res.json({ gifs });
    }),
  );

  return router;
}
