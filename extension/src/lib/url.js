// Site identity helpers. A login is only ever offered to a page whose
// scheme + host + port match where it was saved ("www." is ignored), so an
// https credential is never filled into an http page.

export function parseSite(input, { assumeHttps = false } = {}) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let u;
  try {
    u = new URL(input.trim());
  } catch {
    if (!assumeHttps) return null;
    try {
      u = new URL('https://' + input.trim());
    } catch {
      return null;
    }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const bareHost = host.replace(/^www\./, '');
  return {
    origin: u.origin,
    host,
    displayHost: bareHost,
    secure: u.protocol === 'https:' || isLoopback(host),
    matchKey: `${u.protocol}//${bareHost}${u.port ? ':' + u.port : ''}`,
  };
}

export function matchKey(input) {
  return parseSite(input)?.matchKey ?? null;
}

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}
