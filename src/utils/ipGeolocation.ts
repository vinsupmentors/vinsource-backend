/**
 * Best-effort IP → location lookup for the student onboarding document
 * signing feature. Uses ip-api.com's free, no-key HTTP endpoint (45
 * requests/min limit — comfortably enough for onboarding volume). Any
 * failure (network error, rate limit, private/local IP in dev) resolves to
 * `null` rather than throwing, since a missing location must never block a
 * student from signing a document.
 */
export async function resolveIpLocation(ip: string | undefined): Promise<string | null> {
  if (!ip) return null;

  // Strip an IPv6-mapped-IPv4 prefix (e.g. "::ffff:203.0.113.5") down to the
  // plain address, and skip local/private addresses outright — ip-api.com
  // can't resolve those anyway and there's no point spending the request.
  const clean = ip.replace(/^::ffff:/, '');
  if (clean === '::1' || clean === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(clean)) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,city,regionName,country`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { status: string; city?: string; regionName?: string; country?: string };
    if (data.status !== 'success') return null;
    return [data.city, data.regionName, data.country].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}
