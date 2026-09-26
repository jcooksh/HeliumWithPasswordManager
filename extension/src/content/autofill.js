// Helium Vault content script.
//
// Runs in every http(s) frame, in the extension's isolated world. It finds
// login fields, asks the background whether to show suggestions, and fills
// or captures credentials. Security rules it follows:
//   * It never receives the list of saved usernames — the suggestion menu is a
//     chrome-extension:// iframe the page cannot read.
//   * It only receives a password after the user picks a login, and the
//     background only sends it to this exact document if the origin matches.
//   * It never fills invisible fields (defeats hidden-form harvesting).

(() => {
  if (window.__heliumVault) return;
  window.__heliumVault = true;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  const USERNAME_HINT = /user|login|email|e-mail|account|identifier|acct|phone|mobile|handle/i;
  const USERNAME_EXACT = /^(user(name|id|_?name)?|login(id|name)?|e-?mail|identifier|account|signin)$/i;
  const NOT_USERNAME = /search|captcha|otp|one.?time|code|token|2fa|totp|mfa|pin|zip|postal|coupon|promo|card|cvc|cvv/i;
  const NEW_PASSWORD = /new|confirm|repeat|retype|verify|again|register|signup|sign.up|create/i;
  const TEXTLIKE = new Set(['text', 'email', 'tel', 'url', '']);

  const seenPasswordFields = new WeakSet(); // survives "show password" type toggles
  let activeField = null;
  let lastUsername = ''; // for "enter email, then password" sign-in flows
  let helloSent = false;

  // ---- field classification ------------------------------------------------

  function hints(el) {
    return [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('autocomplete')]
      .filter(Boolean).join(' ');
  }

  function isPasswordField(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type === 'password') {
      seenPasswordFields.add(el);
      return true;
    }
    return seenPasswordFields.has(el);
  }

  function isTextField(el) {
    return el instanceof HTMLInputElement && TEXTLIKE.has(el.getAttribute('type')?.toLowerCase() ?? '')
      && !el.disabled && !el.readOnly;
  }

  function isVisible(el) {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1;
  }

  function inputsIn(scope) {
    return [...scope.querySelectorAll('input')].filter((i) => i.type !== 'hidden' && !i.disabled);
  }

  // The form (or form-like container) an input belongs to.
  function scopeOf(el) {
    if (el.form) return el.form;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.querySelector('input[type=password]') && n.querySelectorAll('input').length <= 12) return n;
    }
    return el.getRootNode() instanceof ShadowRoot ? el.getRootNode() : document;
  }

  function passwordsIn(scope) {
    return inputsIn(scope).filter(isPasswordField);
  }

  function isNewPasswordField(el, scope) {
    const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (ac.includes('current-password')) return false;
    if (ac.includes('new-password')) return true;
    if (NEW_PASSWORD.test(hints(el))) return true;
    const pw = passwordsIn(scope).filter(isVisible);
    // Sign-up form: password + confirm password.
    return pw.length === 2;
  }

  function looksLikeUsername(el) {
    if (!isTextField(el)) return false;
    const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (ac.includes('one-time-code')) return false;
    if (ac.includes('username') || ac.includes('email') || ac.includes('webauthn')) return true;
    const h = hints(el);
    if (NOT_USERNAME.test(h)) return false;
    return el.type === 'email' || USERNAME_HINT.test(h);
  }

  // Username + password fields for the form containing `anchor`.
  function loginFields(anchor) {
    const scope = scopeOf(anchor);
    const inputs = inputsIn(scope);
    const passwords = inputs.filter(isPasswordField);
    const firstPw = passwords[0];
    let username = null;
    const before = firstPw ? inputs.slice(0, inputs.indexOf(firstPw)) : inputs;
    const candidates = before.filter(isTextField);
    username = candidates.filter(looksLikeUsername).filter(isVisible).pop()
      ?? candidates.filter(isVisible).pop()
      ?? candidates.find((i) => /username|email/i.test(i.getAttribute('autocomplete') ?? '')) // hidden username hint
      ?? null;
    if (username && NOT_USERNAME.test(hints(username))) username = null;
    return { scope, username, passwords };
  }

  // What kind of login field is `el`, if any?
  function classify(el) {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return null;
    if (isPasswordField(el)) {
      const scope = scopeOf(el);
      if (/one-time-code/i.test(el.getAttribute('autocomplete') ?? '')) return null;
      return isNewPasswordField(el, scope) ? 'new-password' : 'password';
    }
    if (!looksLikeUsername(el)) return null;
    const scope = scopeOf(el);
    const hasPassword = passwordsIn(scope).length > 0;
    const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
    // Username-only step of a two-step sign-in needs a strong signal.
    if (hasPassword || ac.includes('username') || USERNAME_EXACT.test(el.name) || USERNAME_EXACT.test(el.id)) {
      if (hasPassword && passwordsIn(scope).filter(isVisible).some((p) => isNewPasswordField(p, scope))) return null;
      return 'username';
    }
    return null;
  }

  // ---- filling --------------------------------------------------------------

  const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function setValue(el, value) {
    el.focus({ preventScroll: true });
    nativeValueSetter.call(el, value); // works with React/Vue value tracking
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function firstLoginAnchor() {
    const all = [...document.querySelectorAll('input')];
    return all.find((i) => isPasswordField(i) && isVisible(i) && !isNewPasswordField(i, scopeOf(i)))
      ?? all.find((i) => looksLikeUsername(i) && isVisible(i) && classify(i) === 'username')
      ?? null;
  }

  function fill(username, password) {
    const anchor = activeField?.isConnected && isVisible(activeField) ? activeField : firstLoginAnchor();
    if (!anchor) return false;
    const f = loginFields(anchor);
    const pw = f.passwords.filter(isVisible).find((p) => !isNewPasswordField(p, f.scope)) ?? f.passwords.find(isVisible);
    const userField = isPasswordField(anchor) ? f.username : (classify(anchor) === 'username' ? anchor : f.username);
    let filled = false;
    if (userField && username && (isVisible(userField) || /username|email/i.test(userField.getAttribute('autocomplete') ?? ''))) {
      setValue(userField, username);
      filled = true;
    }
    if (pw && password) {
      setValue(pw, password);
      filled = true;
    }
    if (username) lastUsername = username;
    return filled;
  }

  function fillGenerated(password) {
    const anchor = activeField?.isConnected ? activeField : null;
    if (!anchor) return;
    const f = loginFields(anchor);
    const targets = f.passwords.filter((p) => isVisible(p) && isNewPasswordField(p, f.scope));
    for (const p of targets.length ? targets : [anchor]) setValue(p, password);
  }

  // ---- in-page UI (extension-origin iframes in a closed shadow root) --------

  const frames = new Map(); // token -> { host, iframe, kind, anchor }

  function mountFrame(kind, token, anchor) {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL(`src/ui/${kind}.html`) + '#' + token;
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('scrolling', 'no');
    iframe.style.cssText = 'all:initial;display:block;border:0;width:100%;height:100%;color-scheme:normal;';
    root.append(iframe);
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:block;'
      + 'border-radius:10px;overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,.28);';
    host.style.height = kind === 'savebar' ? '170px' : '52px';
    (document.body ?? document.documentElement).append(host);
    frames.set(token, { host, iframe, kind, anchor });
    position(frames.get(token));
    return host;
  }

  function position(f) {
    if (f.kind === 'savebar') {
      f.host.style.top = '12px';
      f.host.style.right = '12px';
      f.host.style.width = 'min(380px, calc(100vw - 24px))';
      return;
    }
    const r = f.anchor.getBoundingClientRect();
    const width = Math.max(Math.min(r.width, 420), 280);
    f.host.style.width = width + 'px';
    f.host.style.left = Math.max(4, Math.min(r.left, innerWidth - width - 4)) + 'px';
    const h = parseFloat(f.host.style.height) || 52;
    const below = r.bottom + 4;
    f.host.style.top = (below + h > innerHeight && r.top - h - 4 > 0 ? r.top - h - 4 : below) + 'px';
  }

  function unmount(token) {
    const f = frames.get(token);
    if (!f) return;
    f.host.remove();
    frames.delete(token);
  }

  function closeDropdowns() {
    for (const [token, f] of frames) if (f.kind === 'dropdown') unmount(token);
  }

  function isOurHost(node) {
    for (const f of frames.values()) if (f.host === node) return true;
    return false;
  }

  let reposition = 0;
  const onViewportChange = () => {
    if (reposition) return;
    reposition = requestAnimationFrame(() => {
      reposition = 0;
      for (const f of frames.values()) {
        if (f.kind === 'dropdown' && (!f.anchor.isConnected || !isVisible(f.anchor))) closeDropdowns();
        else position(f);
      }
    });
  };
  addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  addEventListener('resize', onViewportChange, { passive: true });

  // ---- events -----------------------------------------------------------------

  let focusSeq = 0;
  async function onFieldActivated(el) {
    const kind = classify(el);
    if (!kind) {
      if (!isOurHost(el)) closeDropdowns();
      return;
    }
    activeField = el;
    if ([...frames.values()].some((f) => f.kind === 'dropdown' && f.anchor === el)) return;
    closeDropdowns();
    const seq = ++focusSeq;
    const res = await send({ type: 'cs.focus', fieldKind: kind });
    if (seq !== focusSeq || deepActive() !== el) return;
    if (res?.ok && res.show) mountFrame('dropdown', res.token, el);
  }

  function deepActive() {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  document.addEventListener('focusin', (e) => onFieldActivated(e.composedPath()[0]), true);
  document.addEventListener('click', (e) => {
    const el = e.composedPath()[0];
    if (el instanceof HTMLInputElement && el === deepActive()) onFieldActivated(el);
  }, true);
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = deepActive();
      if (!isOurHost(document.activeElement) && !(a && classify(a))) closeDropdowns();
    }, 200);
  }, true);
  // Escape or typing dismisses the menu, including one that is still loading.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      focusSeq++;
      closeDropdowns();
    }
  }, true);
  document.addEventListener('input', (e) => {
    const el = e.composedPath()[0];
    if (e.isTrusted && classify(el) === 'username') lastUsername = el.value;
    if (e.isTrusted && el === activeField) {
      focusSeq++;
      closeDropdowns();
    }
  }, true);

  // ---- capturing logins to offer "save password" --------------------------------

  let lastCapture = '';
  function capture(scope) {
    const passwords = passwordsIn(scope).filter((p) => p.value);
    if (!passwords.length) return;
    const newOnes = passwords.filter((p) => isNewPasswordField(p, scope));
    const password = (newOnes.length ? newOnes[newOnes.length - 1] : passwords[0]).value;
    const { username } = loginFields(passwords[0]);
    const user = username?.value || lastUsername || '';
    const key = user + '\n' + password;
    if (key === lastCapture) return;
    lastCapture = key;
    setTimeout(() => {
      if (lastCapture === key) lastCapture = '';
    }, 5000);
    send({ type: 'cs.capture', username: user, password });
  }

  document.addEventListener('submit', (e) => {
    if (e.isTrusted) capture(e.target);
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const el = e.composedPath()[0];
    const btn = el instanceof Element && el.closest('button, input[type=submit], input[type=button], [role=button], a');
    if (!btn) return;
    const scope = scopeOf(btn);
    if (passwordsIn(scope).some((p) => p.value)) capture(scope);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter') return;
    const el = e.composedPath()[0];
    if (el instanceof HTMLInputElement && classify(el)) capture(scopeOf(el));
  }, true);

  // ---- messages from the background ------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    switch (msg?.type) {
      case 'bg.fill':
        closeDropdowns();
        sendResponse({ filled: fill(msg.username, msg.password) });
        return false;
      case 'bg.fillGenerated':
        fillGenerated(msg.password);
        return false;
      case 'bg.closeUi':
        unmount(msg.token);
        if (!frames.size && activeField?.isConnected) activeField.focus({ preventScroll: true });
        return false;
      case 'bg.resizeUi': {
        const f = frames.get(msg.token);
        if (f) {
          f.host.style.height = msg.height + 'px';
          position(f);
        }
        return false;
      }
      case 'bg.showSavebar':
        if (window.top === window && ![...frames.values()].some((f) => f.kind === 'savebar')) {
          mountFrame('savebar', msg.token, null);
        }
        return false;
      case 'bg.fillFocused': {
        const el = deepActive();
        if (!document.hasFocus() || !(el instanceof HTMLInputElement) || !classify(el)) return false;
        activeField = el;
        send({ type: 'cs.requestFill' }).then((res) => {
          if (res?.dropdown) {
            closeDropdowns();
            mountFrame('dropdown', res.dropdown, el);
          }
        });
        return false;
      }
      default:
        return false;
    }
  });

  // ---- startup -------------------------------------------------------------------

  function scan() {
    if (helloSent) return;
    const found = [...document.querySelectorAll('input')].some((i) => isPasswordField(i) || classify(i) === 'username');
    if (found) {
      helloSent = true;
      send({ type: 'cs.hello' });
      const el = deepActive();
      if (el instanceof HTMLInputElement) onFieldActivated(el); // autofocused field
    }
  }

  let scanTimer = 0;
  new MutationObserver(() => {
    if (helloSent || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });

  scan();
  if (window.top === window) {
    send({ type: 'cs.pageReady' }).then((res) => {
      if (res?.savebar && ![...frames.values()].some((f) => f.kind === 'savebar')) mountFrame('savebar', res.savebar, null);
    });
  }
})();
