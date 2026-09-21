import { type MessageAttachment, errors } from '../types.js';

/**
 * Hosts Giphy serves actual image bytes from. `media0`-`media4` are the shards
 * their API hands out; `i.giphy.com` is the canonical single-image host.
 *
 * This allowlist is the whole point of validating attachments. Without it,
 * "send a GIF" means "make every member of this room issue a GET to a URL I
 * chose", which is an IP and user-agent harvester pointed at a private room,
 * and a way to render arbitrary remote images under someone else's name.
 */
const ALLOWED_HOSTS = /^(?:media\d*|i)\.giphy\.com$/;

/** Generous enough for any real CDN URL, short enough to bound a row. */
const MAX_URL_LENGTH = 2048;
const MAX_ALT_LENGTH = 200;
/** Giphy's own originals top out well below this. */
const MAX_DIMENSION = 4096;

export interface AttachmentInput {
  kind?: unknown;
  url?: unknown;
  width?: unknown;
  height?: unknown;
  alt?: unknown;
}

function dimension(value: unknown, name: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1) {
    throw errors.invalid(`Attachment ${name} must be a positive integer`);
  }
  if (parsed > MAX_DIMENSION) {
    throw errors.invalid(`Attachment ${name} exceeds ${MAX_DIMENSION}px`);
  }
  return parsed;
}

/**
 * Validates and normalises an attachment from a client. Throws an AppError on
 * anything it does not recognise rather than storing it and hoping the
 * renderer copes.
 *
 * Applied on every write path — WebSocket and REST alike — and also to Giphy's
 * own search results before they are handed to a client, so the picker can
 * never surface a GIF that `message.send` would then reject.
 */
export function parseAttachment(input: AttachmentInput): MessageAttachment {
  if (input.kind !== 'gif') throw errors.invalid('Unsupported attachment kind');

  if (typeof input.url !== 'string' || input.url.length === 0) {
    throw errors.invalid('Attachment url is required');
  }
  if (input.url.length > MAX_URL_LENGTH) {
    throw errors.invalid(`Attachment url exceeds ${MAX_URL_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw errors.invalid('Attachment url is not a valid URL');
  }

  if (parsed.protocol !== 'https:') {
    throw errors.invalid('Attachment url must use https');
  }
  // Credentials in the URL would be echoed to every viewer, and `user@evil`
  // is a classic way to make a hostname read as an allowed one.
  if (parsed.username !== '' || parsed.password !== '') {
    throw errors.invalid('Attachment url must not contain credentials');
  }
  if (!ALLOWED_HOSTS.test(parsed.hostname)) {
    throw errors.invalid('Attachment url must be hosted by Giphy');
  }

  const alt = typeof input.alt === 'string' ? input.alt.trim().slice(0, MAX_ALT_LENGTH) : '';

  return {
    kind: 'gif',
    // Re-serialise from the parsed URL rather than trusting the input string.
    url: parsed.toString(),
    width: dimension(input.width, 'width'),
    height: dimension(input.height, 'height'),
    alt,
  };
}

/** True when the input is a well-formed, allowlisted attachment. */
export function isValidAttachment(input: AttachmentInput): boolean {
  try {
    parseAttachment(input);
    return true;
  } catch {
    return false;
  }
}
