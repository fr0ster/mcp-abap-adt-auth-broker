/**
 * URL text the CLI composes from what it was given (a service key's UAA URL, a
 * `--uaa-url`), in plain linear code: no regular expression runs over an
 * argument or a file the user handed over.
 */

/** `url` without the slashes it ends in — what `/\/+$/` removed, in one pass. */
export function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f) end -= 1;
  return url.slice(0, end);
}
