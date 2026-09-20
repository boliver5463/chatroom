/**
 * Usernames may contain letters, digits, underscore, dot and dash. The leading
 * boundary check stops `email@example.com` from being read as a mention of
 * `example.com`, and the trailing trim drops sentence punctuation ("@bob.").
 */
const MENTION_PATTERN = /(^|[^A-Za-z0-9_@.-])@([A-Za-z0-9_.-]{2,32})/g;

const EVERYONE_ALIASES = new Set(['all', 'here', 'channel', 'everyone']);

export interface ParsedMentions {
  /** Distinct candidate usernames, lowercased. Not yet checked against the DB. */
  usernames: string[];
  /** True if the body contained @all / @here / @channel / @everyone. */
  everyone: boolean;
}

export function parseMentions(body: string): ParsedMentions {
  const usernames = new Set<string>();
  let everyone = false;

  for (const match of body.matchAll(MENTION_PATTERN)) {
    const raw = match[2];
    if (!raw) continue;

    // "@bob." and "@bob-" are almost always sentence punctuation, not a name.
    const name = raw.replace(/[.-]+$/, '').toLowerCase();
    if (name.length < 2) continue;

    if (EVERYONE_ALIASES.has(name)) everyone = true;
    else usernames.add(name);
  }

  return { usernames: [...usernames], everyone };
}
