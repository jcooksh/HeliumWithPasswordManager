// Suggestion menu shown under a login field. Runs on the extension's origin,
// so the web page can't read which accounts are listed here.
import { h, send, initial, KEY_ICON } from './dom.js';
import { generatePassword } from '../lib/generator.js';

const token = location.hash.slice(1);
const root = document.getElementById('root');
const call = (type, extra) => send(type, { token, kind: 'dropdown', ...extra });

function close() {
  call('ui.close').catch(() => {});
}

function render(ctx) {
  const items = [];
  if (ctx.state === 'locked') {
    items.push(h('button', { class: 'item', onclick: () => call('ui.unlock') },
      h('span', { class: 'avatar' }, KEY_ICON),
      h('span', { class: 'grow' }, h('div', {}, 'Unlock Helium Vault'), h('div', { class: 'sub' }, 'to use saved passwords'))));
  }
  for (const login of ctx.logins) {
    items.push(h('button', { class: 'item', title: `Fill ${login.username || 'password'}`, onclick: () => call('ui.fill', { id: login.id }) },
      h('span', { class: 'avatar' }, initial(login.username || ctx.site)),
      h('span', { class: 'grow' },
        h('div', { class: 'ellipsis' }, login.username || '(no username)'),
        h('div', { class: 'sub ellipsis' }, login.title || ctx.site))));
  }
  if (ctx.canGenerate && ctx.state === 'unlocked') {
    const pw = generatePassword({ length: 20 });
    items.push(h('button', { class: 'item', onclick: () => call('ui.useGenerated', { password: pw }) },
      h('span', { class: 'avatar' }, '✨'),
      h('span', { class: 'grow' },
        h('div', {}, 'Use a strong password'),
        h('div', { class: 'sub mono ellipsis' }, pw))));
  }
  root.replaceChildren(...[
    h('div', { class: 'head' },
      h('span', { class: 'brand' }, KEY_ICON + ' Helium Vault'),
      h('span', { class: 'grow ellipsis' }, '· ' + ctx.site),
      ctx.secure ? null : h('span', { class: 'warn' }, 'Not secure')),
    ...items,
    ctx.state === 'unlocked'
      ? h('div', { class: 'foot' }, h('button', { class: 'link', onclick: () => call('ui.openManager') }, 'Manage passwords'))
      : null,
  ].filter(Boolean));
}

new ResizeObserver(() => {
  call('ui.resize', { height: Math.ceil(root.getBoundingClientRect().height) + 2 }).catch(() => {});
}).observe(root);

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
});

let lastState = null;
async function load() {
  try {
    const ctx = await call('ui.context');
    if (ctx.state === 'unlocked' && !ctx.logins.length && !ctx.canGenerate) return close();
    if (ctx.state !== lastState) render(ctx);
    lastState = ctx.state;
  } catch {
    close();
  }
}

// While locked, check back so the menu fills in once the vault is unlocked.
setInterval(() => {
  if (lastState === 'locked') load();
}, 1500);
load();
