export function matchesAllowedUrl(url: string, patterns: readonly string[]): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return false;
  return patterns.some((pattern) => matchesPattern(parsedUrl, pattern));
}

function matchesPattern(url: URL, pattern: string): boolean {
  let parsedPattern: URL;
  try {
    parsedPattern = new URL(pattern.replaceAll('*', 'placeholder.invalid'));
  } catch {
    return false;
  }
  if (parsedPattern.protocol !== url.protocol) return false;

  const hostPattern = parsedPattern.host.replaceAll('placeholder.invalid', '*');
  const pathPattern =
    `${parsedPattern.pathname}${parsedPattern.search}${parsedPattern.hash}`.replaceAll(
      'placeholder.invalid',
      '*',
    );
  return (
    wildcard(url.host, hostPattern) &&
    wildcard(`${url.pathname}${url.search}${url.hash}`, pathPattern)
  );
}

function wildcard(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`).test(value);
}
