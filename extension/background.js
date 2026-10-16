chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'LOOKUP') return;
  (async () => {
    const tabs = await chrome.tabs.query({ url: 'https://tngis.tn.gov.in/*' });
    let tab = tabs.find(t => t.url?.includes('/map-viewer/'));
    if (!tab) tab = tabs[0];
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.tabs.sendMessage(tab.id, { type: 'LOOKUP', coordinates: message.coordinates });
    } else {
      tab = await chrome.tabs.create({ url: 'https://tngis.tn.gov.in/apps/gi_viewer/index.html', active: true });
      await chrome.storage.local.set({ pendingCoordinates: message.coordinates });
    }
    sendResponse({ ok: true, message: 'Site opened. Sign in if needed; complete the CAPTCHA, then the extension will continue.' });
  })().catch(error => sendResponse({ ok: false, message: error.message }));
  return true;
});
