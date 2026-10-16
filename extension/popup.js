const latField = document.querySelector('#lat');
const longField = document.querySelector('#long');
const status = document.querySelector('#status');
const button = document.querySelector('#search');
const result = document.querySelector('#result');

async function loadSample() {
  const [saved, sample] = await Promise.all([
    chrome.storage.local.get(['coordinates']),
    fetch(chrome.runtime.getURL('search.json')).then(r => r.json())
  ]);
  const c = saved.coordinates || sample.coordinates;
  latField.value = c.lat;
  longField.value = c.long;
}

button.addEventListener('click', async () => {
  const lat = Number(latField.value), long = Number(longField.value);
  if (!Number.isFinite(lat) || !Number.isFinite(long) || lat < -90 || lat > 90 || long < -180 || long > 180) {
    status.textContent = 'Enter valid latitude and longitude.';
    return;
  }
  button.disabled = true;
  result.hidden = true;
  status.textContent = 'Opening Tamil Nilam…';
  await chrome.storage.local.set({ coordinates: { lat, long } });
  chrome.runtime.sendMessage({ type: 'LOOKUP', coordinates: { lat, long } }, response => {
    button.disabled = false;
    if (chrome.runtime.lastError || !response?.ok) {
      status.textContent = response?.message || 'Could not start lookup.';
      return;
    }
    status.textContent = response.message;
  });
});
loadSample().catch(() => { status.textContent = 'Could not load sample coordinates.'; });
