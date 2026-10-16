// Site-specific selectors and parcel-detail extraction need to be verified against the live viewer.
// CAPTCHA is intentionally left for the user to solve.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'LOOKUP') runLookup(message.coordinates);
});

async function runLookup(coordinates) {
  const status = (text) => chrome.runtime.sendMessage({ type: 'LOOKUP_STATUS', text });
  if (location.pathname.includes('/apps/gi_viewer/')) {
    status('Sign in through Public and solve the CAPTCHA; then open the map viewer.');
    return;
  }
  status('Map viewer opened. Coordinate entry automation requires verified site selectors.');
  // TODO: inspect the live DOM and implement Filter → Goto, parcel reading, and screenshot capture.
}
