// Offscreen document used only to wipe a copied password from the clipboard.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'offscreen.clearClipboard') return false;
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy, { once: true });
  document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  sendResponse({ ok: true });
  return false;
});
