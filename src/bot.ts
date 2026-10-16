import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium, type Locator, type Page } from 'playwright';

const SITE_URL = 'https://tngis.tn.gov.in/apps/gi_viewer/index.html';
const ROOT = process.cwd();
const CREDENTIALS_PATH = path.join(ROOT, 'config', 'credentials.json');
const SEARCH_PATH = path.join(ROOT, 'config', 'search.json');
const PROFILE_PATH = path.join(ROOT, 'data', 'browser-profile');
const SCREENSHOT_DIR = path.join(ROOT, 'output', 'screenshots');
const RESULTS_DIR = path.join(ROOT, 'output', 'results');

type Credentials = { mobile: string; password: string };
type Coordinates = { lat: number; long: number };
type SearchConfig = { coordinates: Coordinates };
type ParcelDetails = {
  input: Coordinates;
  areaType: 'Rural' | 'Urban';
  district: string;
  taluk: string;
  village: string;
  villageLgdCode: string;
  rWard: string;
  rBlock: string;
  ulpin: string;
  centroid: string;
  surveyNumber: string;
  subDivision: string;
  screenshot: string;
  status: 'success' | 'not_found';
};

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function firstVisible(...candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    if (await candidate.count() && await candidate.first().isVisible().catch(() => false)) return candidate.first();
  }
  return undefined;
}

async function clickIfVisible(locator: Locator | undefined): Promise<boolean> {
  if (!locator || !await locator.isVisible().catch(() => false)) return false;
  await locator.click();
  return true;
}

async function dismissAccountChoice(page: Page): Promise<void> {
  const choiceText = page.getByText(/select how you would like to continue/i).first();
  if (!await choiceText.isVisible().catch(() => false)) return;

  const closeButton = await firstVisible(
    page.locator('.modal.show [data-bs-dismiss="modal"]'),
    page.locator('.modal.show .btn-close'),
    page.locator('.modal.show button[aria-label*="close" i]'),
    page.locator('[role="dialog"] button[aria-label*="close" i]'),
  );
  if (closeButton) {
    await closeButton.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await choiceText.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
}

async function waitForHumanLogin(page: Page, credentials: Credentials): Promise<void> {
  // The landing page can open an account-choice dialog on its own. Close it,
  // then open Login deliberately so the existing-user path is deterministic.
  await dismissAccountChoice(page);
  const loginButtonByRole = page.getByRole('button', { name: /^login$/i });
  await loginButtonByRole.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
  const loginButton = await firstVisible(
    loginButtonByRole,
    page.getByText(/^login$/i),
  );
  if (loginButton) await clickIfVisible(loginButton);

  const existingUser = await firstVisible(
    page.locator('#btnProceedLogin'),
    page.getByRole('heading', { name: /existing user/i }),
    page.getByText(/existing user/i),
  );
  if (existingUser) await existingUser.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  await clickIfVisible(existingUser);

  const publicTab = await firstVisible(
    page.locator('#public-tab'),
    page.getByRole('tab', { name: /^public$/i }),
    page.getByText(/^public$/i),
  );
  await clickIfVisible(publicTab);

  const mobileByPlaceholder = page.getByPlaceholder(/mobile\s*no|mobile|phone/i);
  const mobileByLabel = page.getByLabel(/mobile\s*no|mobile|phone/i);
  await mobileByPlaceholder.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  const mobile = await firstVisible(mobileByPlaceholder, mobileByLabel);
  const password = await firstVisible(
    page.getByPlaceholder(/password/i),
    page.getByLabel(/password/i),
  );

  if (!mobile || !password) {
    await fs.mkdir(path.join(ROOT, 'output'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'output', 'login-form-not-found.png') }).catch(() => undefined);
    throw new Error('The Public login fields did not appear after selecting Existing User. A diagnostic screenshot was saved to output/login-form-not-found.png.');
  }
  await mobile.fill(credentials.mobile);
  await password.fill(credentials.password);
  console.log('Credentials filled. Complete the CAPTCHA and submit Login in the browser.');

  const terminal = readline.createInterface({ input, output });
  await terminal.question('Press Enter here after the map viewer opens. ');
  terminal.close();

  if (!/map-viewer/i.test(page.url())) {
    await page.waitForURL(/map-viewer/i, { timeout: 120_000 }).catch(() => undefined);
  }
  if (!/map-viewer/i.test(page.url())) {
    throw new Error('The map viewer did not open. Check the login/CAPTCHA and try again.');
  }
}

async function closeInitialLayersPanel(page: Page): Promise<void> {
  const layerPanel = page.getByText(/Layers and Tools/i).first();
  if (!await layerPanel.isVisible().catch(() => false)) return;
  const closeButton = await firstVisible(
    page.getByRole('button', { name: /close/i }),
    page.locator('[aria-label*="close" i], [title*="close" i]'),
  );
  await clickIfVisible(closeButton);
}

async function openGoto(page: Page): Promise<() => Promise<void>> {
  const gotoTab = await firstVisible(
    page.getByRole('tab', { name: /goto|go to/i }),
    page.getByText(/^goto$/i),
    page.getByText(/^go to$/i),
  );
  let closeFilter = async () => undefined;
  if (!gotoTab) {
    const filterButton = await firstVisible(
      page.getByRole('button', { name: /filter/i }),
      page.locator('[aria-label*="filter" i], [title*="filter" i]'),
    );
    if (!filterButton) throw new Error('Could not find the Filter control on the map viewer.');
    await filterButton.click();
    closeFilter = async () => { await filterButton.click().catch(() => undefined); };
  }

  const tab = gotoTab ?? await firstVisible(
    page.getByRole('tab', { name: /goto|go to/i }),
    page.getByText(/^goto$/i),
    page.getByText(/^go to$/i),
  );
  if (!tab) throw new Error('Could not find the Goto tab in Filter.');
  await tab.click();
  return closeFilter;
}

function readLabeledValue(lines: string[], labels: string[]): string {
  const allLabels = ['District', 'Taluk', 'Village', 'Town', 'Village LGD Code', 'LGD Code', 'R.Ward', 'R. Ward', 'R Ward', 'R.Block', 'R. Block', 'R Block', 'ULPIN', 'Centroid', 'Survey Number', 'Sub Division'];
  for (const label of labels) {
    const matcher = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：-]?\\s*(.*)$`, 'i');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(matcher);
      if (!match) continue;
      if (match[1].trim()) return match[1].trim();
      const next = lines[i + 1]?.trim() ?? '';
      if (next && !allLabels.some(other => new RegExp(`^${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：-]?`, 'i').test(next))) return next;
    }
  }
  return '';
}

function parcelFromText(text: string, coordinates: Coordinates, screenshot: string): ParcelDetails {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const town = readLabeledValue(lines, ['Town']);
  const ward = readLabeledValue(lines, ['R.Ward', 'R. Ward', 'R Ward']);
  const block = readLabeledValue(lines, ['R.Block', 'R. Block', 'R Block']);
  const areaType: 'Rural' | 'Urban' = town || ward || block ? 'Urban' : 'Rural';
  return {
    input: coordinates,
    areaType,
    district: readLabeledValue(lines, ['District']),
    taluk: readLabeledValue(lines, ['Taluk']),
    village: readLabeledValue(lines, ['Village', 'Town']),
    villageLgdCode: readLabeledValue(lines, ['Village LGD Code', 'LGD Code']),
    rWard: ward,
    rBlock: block,
    ulpin: readLabeledValue(lines, ['ULPIN']),
    centroid: readLabeledValue(lines, ['Centroid']),
    surveyNumber: readLabeledValue(lines, ['Survey Number']),
    subDivision: readLabeledValue(lines, ['Sub Division']),
    screenshot,
    status: 'success',
  };
}

async function waitForMapTiles(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const tiles = Array.from(document.querySelectorAll<HTMLImageElement>('img.leaflet-tile, img[class*="tile"]'));
    return tiles.length > 0 && tiles.every(tile => tile.complete && tile.naturalWidth > 0);
  }, undefined, { timeout: 30_000 }).catch(() => {
    console.warn('Map tile readiness could not be confirmed; capturing the current map view.');
  });
}

async function searchParcel(page: Page, coordinates: Coordinates): Promise<ParcelDetails> {
  const closeFilter = await openGoto(page);
  const latitude = await firstVisible(
    page.getByPlaceholder(/latitude/i),
    page.getByLabel(/latitude/i),
  );
  const longitude = await firstVisible(
    page.getByPlaceholder(/longitude/i),
    page.getByLabel(/longitude/i),
  );
  if (!latitude || !longitude) throw new Error('Could not find the Latitude and Longitude inputs in Goto.');
  await latitude.fill(String(coordinates.lat));
  await longitude.fill(String(coordinates.long));

  const goButton = await firstVisible(
    page.getByRole('button', { name: /^go\s*to$/i }),
    page.getByText(/^go\s*to$/i),
  );
  if (!goButton) throw new Error('Could not find the Go To button.');
  await goButton.click();

  await page.waitForFunction(() => {
    const body = document.body.innerText;
    return /Land Parcel Information|no parcel|no record|not found/i.test(body);
  }, undefined, { timeout: 90_000 });

  const bodyText = await page.locator('body').innerText();
  if (/no parcel|no record|not found/i.test(bodyText) && !/Land Parcel Information/i.test(bodyText)) {
    return {
      input: coordinates, areaType: 'Rural', district: '', taluk: '', village: '', villageLgdCode: '',
      rWard: '', rBlock: '', ulpin: '', centroid: '', surveyNumber: '', subDivision: '', screenshot: '', status: 'not_found',
    };
  }

  const filterButton = await firstVisible(
    page.getByRole('button', { name: /filter/i }),
    page.locator('[aria-label*="filter" i], [title*="filter" i]'),
  );
  if (filterButton && await page.getByText(/^goto$/i).isVisible().catch(() => false)) await closeFilter();

  await page.getByText(/Land Parcel Information/i).first().waitFor({ state: 'visible', timeout: 15_000 });
  await waitForMapTiles(page);

  const name = `${coordinates.lat}_${coordinates.long}`;
  const screenshot = path.join(SCREENSHOT_DIR, `${name}.png`);
  const screenshotRelative = path.relative(ROOT, screenshot).replace(/\\/g, '/');
  await page.screenshot({ path: screenshot, fullPage: false });
  return parcelFromText(bodyText, coordinates, screenshotRelative);
}

async function main(): Promise<void> {
  const credentials = await readJson<Credentials>(CREDENTIALS_PATH);
  const { coordinates } = await readJson<SearchConfig>(SEARCH_PATH);
  if (!credentials.mobile || !credentials.password) throw new Error(`Add mobile and password to ${path.relative(ROOT, CREDENTIALS_PATH)}.`);
  if (!Number.isFinite(coordinates?.lat) || coordinates.lat < -90 || coordinates.lat > 90 || !Number.isFinite(coordinates?.long) || coordinates.long < -180 || coordinates.long > 180) {
    throw new Error(`Enter valid decimal coordinates in ${path.relative(ROOT, SEARCH_PATH)}.`);
  }

  await Promise.all([fs.mkdir(PROFILE_PATH, { recursive: true }), fs.mkdir(SCREENSHOT_DIR, { recursive: true }), fs.mkdir(RESULTS_DIR, { recursive: true })]);
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!/map-viewer/i.test(page.url())) await waitForHumanLogin(page, credentials);
    await closeInitialLayersPanel(page);
    const result = await searchParcel(page, coordinates);
    const name = `${coordinates.lat}_${coordinates.long}`;
    const resultPath = path.join(RESULTS_DIR, `${name}.json`);
    await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`${result.status}: ${path.relative(ROOT, resultPath)}`);
    if (result.screenshot) console.log(`Screenshot: ${result.screenshot}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
