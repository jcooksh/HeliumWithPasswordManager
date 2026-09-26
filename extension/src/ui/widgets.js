import { h } from './dom.js';
import { estimateBits } from '../lib/generator.js';

export function passwordInput(attrs = {}) {
  return h('input', { type: 'password', spellcheck: false, autocomplete: 'off', ...attrs });
}

export function strengthMeter(input) {
  const bar = h('div');
  const label = h('div', { class: 'muted' });
  const update = () => {
    const bits = estimateBits(input.value);
    const pct = Math.min(100, (bits / 90) * 100);
    const [color, text] = bits < 45 ? ['var(--danger)', 'Weak'] : bits < 65 ? ['var(--warn)', 'OK'] : ['var(--ok)', 'Strong'];
    bar.style.width = pct + '%';
    bar.style.background = color;
    label.textContent = input.value ? `${text} (~${bits} bits)` : 'Use a long passphrase, e.g. four or more random words.';
  };
  input.addEventListener('input', update);
  update();
  return [h('div', { class: 'meter' }, bar), label];
}
