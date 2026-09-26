// Password generator using the CSPRNG with unbiased (rejection-sampled) picks.

const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*-_=+?',
};

export function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

export function generatePassword({ length = 20, lower = true, upper = true, digits = true, symbols = true } = {}) {
  const chosen = Object.entries({ lower, upper, digits, symbols })
    .filter(([, on]) => on)
    .map(([name]) => SETS[name]);
  if (!chosen.length) chosen.push(SETS.lower);
  length = Math.max(length, chosen.length, 8);

  const all = chosen.join('');
  // One character from every enabled set so site rules are satisfied...
  const out = chosen.map((set) => set[randomInt(set.length)]);
  // ...the rest from the combined alphabet...
  while (out.length < length) out.push(all[randomInt(all.length)]);
  // ...then Fisher-Yates shuffle so the guaranteed ones aren't at the front.
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

// Rough entropy estimate (bits) for the master password strength meter.
export function estimateBits(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  // Penalise heavy repetition ("aaaaaaaaaaaa").
  const effectiveLen = Math.min(pw.length, unique * 2);
  return Math.round(effectiveLen * Math.log2(Math.max(pool, 2)));
}
