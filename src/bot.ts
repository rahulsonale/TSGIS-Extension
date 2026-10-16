import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

const SITE_URL = "https://tngis.tn.gov.in/apps/gi_viewer/index.html";
const ROOT = process.cwd();
const CREDENTIALS_PATH = path.join(ROOT, "config", "credentials.json");
const SEARCH_PATH = path.join(ROOT, "config", "search.json");
const PROFILE_PATH = path.join(ROOT, "data", "browser-profile");
const SCREENSHOT_DIR = path.join(ROOT, "output", "screenshots");
const RESULTS_DIR = path.join(ROOT, "output", "results");

type Credentials = { mobile: string; password: string };
type Coordinates = { lat: number; long: number };
type SearchConfig = { coordinates: Coordinates };
type ParcelDetails = {
  input: Coordinates;
  areaType: "Rural" | "Urban";
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
  status: "success" | "not_found";
};

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function firstVisible(
  ...candidates: Locator[]
): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = await candidate.count();
    for (let index = 0; index < count; index++) {
      const match = candidate.nth(index);
      if (await match.isVisible().catch(() => false)) return match;
    }
  }
  return undefined;
}

async function clickIfVisible(locator: Locator | undefined): Promise<boolean> {
  if (!locator || !(await locator.isVisible().catch(() => false))) return false;
  await locator.click();
  return true;
}

async function dismissAccountChoice(page: Page): Promise<void> {
  const choiceText = page
    .getByText(/select how you would like to continue/i)
    .first();
  // This dialog is injected after initial navigation, so wait briefly for it.
  const appeared = await choiceText
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;

  const closeButton = await firstVisible(
    page.locator('.modal.show [data-bs-dismiss="modal"]'),
    page.locator(".modal.show .btn-close"),
    page.locator(".modal.show button.close"),
    page.locator('.modal.show button[aria-label*="close" i]'),
    page.locator('[role="dialog"] button.close'),
    page.locator('[role="dialog"] button[aria-label*="close" i]'),
  );
  if (closeButton) await closeButton.click().catch(() => undefined);
  else await page.keyboard.press("Escape");

  const dismissed = await choiceText
    .waitFor({ state: "hidden", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!dismissed) {
    // Some site versions do not label the X control; proceed through Existing User.
    const existing = await firstVisible(
      page.locator("#btnProceedLogin"),
      page.getByText(/^Existing User$/i),
    );
    await clickIfVisible(existing);
  }
}

async function requestCaptchaFromUi(context: BrowserContext, sitePage: Page): Promise<string> {
  let resolveAnswer!: (answer: string) => void;
  const answerPromise = new Promise<string>((resolve) => { resolveAnswer = resolve; });
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Tamil Nilam CAPTCHA</title><style>' +
    'body{margin:0;background:#eef4f6;color:#17313a;font:15px Arial,sans-serif}.card{max-width:440px;margin:12vh auto;background:white;padding:28px;border-radius:14px;box-shadow:0 8px 28px #18333a22}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;color:#52656d}label{display:block;font-weight:600;margin:20px 0 8px}input{box-sizing:border-box;width:100%;font-size:18px;padding:12px;border:1px solid #9aafb8;border-radius:7px}button{width:100%;padding:12px;margin-top:14px;border:0;border-radius:7px;background:#126b79;color:white;font-size:16px;cursor:pointer}button:disabled{opacity:.65}#status{min-height:22px;margin-top:12px;color:#126b79}' +
    '</style></head><body><main class="card"><h1>Enter Tamil Nilam CAPTCHA</h1>' +
    '<p>Switch to the Tamil Nilam tab to read the CAPTCHA. Return here, enter it exactly as shown, and submit.</p>' +
    '<form id="form"><label for="captcha">CAPTCHA text</label><input id="captcha" name="captcha" type="text" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" required autofocus>' +
    '<button id="submit" type="submit">Send CAPTCHA</button><div id="status" role="status"></div></form></main>' +
    '<script>const f=document.getElementById("form"),i=document.getElementById("captcha"),b=document.getElementById("submit"),s=document.getElementById("status");f.addEventListener("submit",async e=>{e.preventDefault();if(!i.value.trim()){i.focus();return}s.textContent="Sending…";b.disabled=true;try{const r=await fetch("/captcha",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({captcha:i.value.trim()})});if(!r.ok)throw new Error("Could not send CAPTCHA");s.textContent="CAPTCHA sent. Returning to Tamil Nilam…"}catch(err){s.textContent=err.message;b.disabled=false}});</script></body></html>';

  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/captcha') {
      response.writeHead(404).end('Not found');
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { captcha?: unknown };
        if (typeof parsed.captcha !== 'string' || !parsed.captcha.trim()) {
          response.writeHead(400).end('Enter the CAPTCHA first.');
          return;
        }
        resolveAnswer(parsed.captcha.trim());
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('OK');
      } catch {
        response.writeHead(400).end('Invalid request.');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the CAPTCHA entry UI.');
  const uiPage = await context.newPage();
  try {
    await uiPage.goto('http://127.0.0.1:' + address.port + '/', { waitUntil: 'domcontentloaded' });
    await uiPage.bringToFront();
    console.log('CAPTCHA entry UI is open in another browser tab. Switch to the Tamil Nilam tab to read the code, then submit it here.');
    return await answerPromise;
  } finally {
    if (!uiPage.isClosed()) await uiPage.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await sitePage.bringToFront().catch(() => undefined);
  }
}

async function waitForHumanLogin(
  context: BrowserContext,
  page: Page,
  credentials: Credentials,
): Promise<void> {
  console.log("Waiting for the Tamil Nilam login screen…");
  await dismissAccountChoice(page);

  const loginModal = page.locator("#loginModal");
  const mobileInput = page
    .getByPlaceholder(/mobile\s*no|mobile|phone/i)
    .or(page.getByLabel(/mobile\s*no|mobile|phone/i))
    .or(page.locator('input[type="tel"]'))
    .first();
  const passwordInput = page
    .getByPlaceholder(/password/i)
    .or(page.getByLabel(/password/i))
    .or(page.locator('input[type="password"]'))
    .first();

  // This site version can open directly to the Public login form. Detect it
  // before looking for an Existing User card, which may not be present.
  let formReady = await mobileInput.isVisible().catch(() => false);
  if (!formReady) {
    const modalAlreadyOpen = await loginModal.isVisible().catch(() => false);
    if (!modalAlreadyOpen) {
      const loginButton = page
        .getByRole("button", { name: /^login$/i })
        .or(page.getByText(/^login$/i))
        .first();
      await loginButton
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => undefined);
      if (await loginButton.isVisible().catch(() => false)) {
        console.log("Opening login options…");
        await loginButton.click({ timeout: 8_000 }).catch(async () => {
          if (!(await loginModal.isVisible().catch(() => false)))
            throw new Error("Could not open Login options.");
        });
      }
    } else {
      console.log("Login options are already open.");
    }

    formReady = await mobileInput
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!formReady) {
      console.log("Waiting for the Existing User option…");
      const existingUser = loginModal
        .locator("#btnProceedLogin")
        .or(loginModal.getByText(/^Existing User$/i))
        .first();
      await existingUser
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(async () => {
          await fs.mkdir(path.join(ROOT, "output"), { recursive: true });
          await page
            .screenshot({
              path: path.join(ROOT, "output", "login-choice-not-found.png"),
            })
            .catch(() => undefined);
          throw new Error(
            "Neither the Public login form nor Existing User option appeared. Screenshot saved to output/login-choice-not-found.png.",
          );
        });
      await existingUser.click();
    }
  }

  console.log("Ensuring Public login is selected…");
  const publicTab = page
    .locator("#public-tab")
    .or(page.getByRole("tab", { name: /^public$/i }))
    .or(loginModal.getByText(/^public$/i))
    .first();
  if (await publicTab.isVisible().catch(() => false)) {
    const selected = await publicTab
      .getAttribute("aria-selected")
      .catch(() => null);
    const classes = await publicTab.getAttribute("class").catch(() => "");
    if (selected !== "true" && !/active/i.test(classes ?? ""))
      await publicTab.click();
  }

  await mobileInput
    .waitFor({ state: "visible", timeout: 20_000 })
    .catch(async () => {
      await fs.mkdir(path.join(ROOT, "output"), { recursive: true });
      await page
        .screenshot({
          path: path.join(ROOT, "output", "login-form-not-found.png"),
        })
        .catch(() => undefined);
      throw new Error(
        "Mobile number field did not appear. Screenshot saved to output/login-form-not-found.png.",
      );
    });
  await passwordInput.waitFor({ state: "visible", timeout: 10_000 });
  await mobileInput.fill(credentials.mobile);
  await passwordInput.fill(credentials.password);
  console.log(
    "Credentials filled. Enter the CAPTCHA in the browser helper panel.",
  );
  const captchaAnswer = await requestCaptchaFromUi(context, page);

  const captchaInput = loginModal
    .getByPlaceholder(/captcha/i)
    .or(loginModal.getByLabel(/captcha/i))
    .or(loginModal.locator('input[placeholder*="captcha" i]'))
    .first();
  await captchaInput.waitFor({ state: "visible", timeout: 10_000 });
  await captchaInput.fill(captchaAnswer);

  const submitLogin = loginModal
    .getByRole("button", { name: /^login\b/i })
    .or(loginModal.locator('button[type="submit"]'))
    .first();
  await submitLogin.waitFor({ state: "visible", timeout: 10_000 });
  await submitLogin.click();
  console.log("Login submitted. Waiting for the map viewer…");

  if (!/map-viewer/i.test(page.url())) {
    await page
      .waitForURL(/map-viewer/i, { timeout: 120_000 })
      .catch(() => undefined);
  }
  if (!/map-viewer/i.test(page.url())) {
    throw new Error(
      "The map viewer did not open. Check the CAPTCHA and credentials, then run the search again.",
    );
  }
}

async function closeInitialLayersPanel(page: Page): Promise<void> {
  const layerPanel = page.getByText(/Layers and Tools/i).first();
  if (!(await layerPanel.isVisible().catch(() => false))) return;
  const closeButton = await firstVisible(
    page.getByRole("button", { name: /close/i }),
    page.locator('[aria-label*="close" i], [title*="close" i]'),
  );
  await clickIfVisible(closeButton);
}

async function openGoto(page: Page): Promise<() => Promise<void>> {
  console.log("Opening Filter…");
  let closeFilter = async () => undefined;

  const gotoLocators = () => [
    page.getByRole("tab", { name: /goto|go to/i }),
    page.getByRole("button", { name: /^\s*goto\s*$/i }),
    page
      .locator('[role="tab"], button, a, [role="button"]')
      .filter({ hasText: /^\s*goto\s*$/i }),
    page.getByText(/^\s*goto\s*$/i),
    page.getByText(/^\s*go to\s*$/i),
  ];
  let gotoTab = await firstVisible(...gotoLocators());

  if (!gotoTab) {
    const filterButton = await firstVisible(
      page.getByRole("button", { name: /filter/i }),
      page.locator('[aria-label*="filter" i], [title*="filter" i]'),
      page.locator(
        'button:has(i[class*="filter" i]), button:has(svg[class*="filter" i]), [role="button"]:has(i[class*="filter" i]), [role="button"]:has(svg[class*="filter" i])',
      ),
      page
        .locator(
          'i[class*="filter" i], svg[class*="filter" i], [class*="filter-icon" i]',
        )
        .locator(
          'xpath=ancestor::*[self::button or self::a or @role="button"][1]',
        ),
    );
    if (!filterButton) {
      await fs.mkdir(path.join(ROOT, "output"), { recursive: true });
      await page
        .screenshot({
          path: path.join(ROOT, "output", "filter-control-not-found.png"),
        })
        .catch(() => undefined);
      throw new Error(
        "Could not find the Filter funnel. Screenshot saved to output/filter-control-not-found.png.",
      );
    }
    await filterButton.click();
    closeFilter = async () => {
      const filterHeading = page.getByText(/^filter$/i).first();
      if (!(await filterHeading.isVisible().catch(() => false))) return;
      await filterButton.click().catch(() => undefined);
      const closed = await filterHeading
        .waitFor({ state: "hidden", timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (!closed && (await filterHeading.isVisible().catch(() => false))) {
        // Retry the same funnel toggle if the panel's close animation lagged.
        await filterButton.click().catch(() => undefined);
        await filterHeading
          .waitFor({ state: "hidden", timeout: 5_000 })
          .catch(() => {
            console.warn(
              "Filter panel stayed open; parcel details will still be saved.",
            );
          });
      }
    };
    console.log("Filter opened. Waiting for Goto…");
    await page
      .getByText(/^filter$/i)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => undefined);
    gotoTab = await firstVisible(...gotoLocators());
    if (!gotoTab) {
      const gotoText = page
        .getByText(/^goto$/i)
        .or(page.getByText(/^go to$/i))
        .first();
      await gotoText
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => undefined);
      gotoTab = await firstVisible(...gotoLocators());
    }
  }

  if (!gotoTab) {
    await fs.mkdir(path.join(ROOT, "output"), { recursive: true });
    await page
      .screenshot({ path: path.join(ROOT, "output", "goto-tab-not-found.png") })
      .catch(() => undefined);
    throw new Error(
      "Filter opened, but the Goto tab did not appear. Screenshot saved to output/goto-tab-not-found.png.",
    );
  }
  await gotoTab.click();
  console.log("Goto selected.");
  return closeFilter;
}

function readLabeledValue(lines: string[], labels: string[]): string {
  const allLabels = [
    "District",
    "Taluk",
    "Village",
    "Town",
    "Village LGD Code",
    "LGD Code",
    "R.Ward",
    "R. Ward",
    "R Ward",
    "R.Block",
    "R. Block",
    "R Block",
    "ULPIN",
    "Centroid",
    "Survey Number",
    "Sub Division",
  ];
  for (const label of labels) {
    const matcher = new RegExp(
      `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：-]?\\s*(.*)$`,
      "i",
    );
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(matcher);
      if (!match) continue;
      if (match[1].trim()) return match[1].trim();
      const next = lines[i + 1]?.trim() ?? "";
      if (
        next &&
        !allLabels.some((other) =>
          new RegExp(
            `^${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：-]?`,
            "i",
          ).test(next),
        )
      )
        return next;
    }
  }
  return "";
}

function parcelFromText(
  text: string,
  coordinates: Coordinates,
  screenshot: string,
): ParcelDetails {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const town = readLabeledValue(lines, ["Town"]);
  const ward = readLabeledValue(lines, ["R.Ward", "R. Ward", "R Ward"]);
  const block = readLabeledValue(lines, ["R.Block", "R. Block", "R Block"]);
  const areaType: "Rural" | "Urban" = town || ward || block ? "Urban" : "Rural";
  return {
    input: coordinates,
    areaType,
    district: readLabeledValue(lines, ["District"]),
    taluk: readLabeledValue(lines, ["Taluk"]),
    village: readLabeledValue(lines, ["Village", "Town"]),
    villageLgdCode: readLabeledValue(lines, ["Village LGD Code", "LGD Code"]),
    rWard: ward,
    rBlock: block,
    ulpin: readLabeledValue(lines, ["ULPIN"]),
    centroid: readLabeledValue(lines, ["Centroid"]),
    surveyNumber: readLabeledValue(lines, ["Survey Number"]),
    subDivision: readLabeledValue(lines, ["Sub Division"]),
    screenshot,
    status: "success",
  };
}

async function waitForMapTiles(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const tiles = Array.from(
          document.querySelectorAll<HTMLImageElement>(
            'img.leaflet-tile, img[class*="tile"]',
          ),
        );
        return (
          tiles.length > 0 &&
          tiles.every((tile) => tile.complete && tile.naturalWidth > 0)
        );
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {
      console.warn(
        "Map tile readiness could not be confirmed; capturing the current map view.",
      );
    });
}

async function saveScreenshot(page: Page, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  console.log('Saving screenshot to: ' + filePath);
  await page.screenshot({ path: filePath, fullPage: false });
  const savedFile = await fs.stat(filePath);
  if (savedFile.size === 0) throw new Error('Screenshot file was created but is empty: ' + filePath);
  console.log('Screenshot saved (' + savedFile.size + ' bytes).');
}

async function searchParcel(
  page: Page,
  coordinates: Coordinates,
): Promise<ParcelDetails> {
  const closeFilter = await openGoto(page);
  console.log('Waiting for the Goto coordinate fields…');
  const latitude = await firstVisible(
    page.getByPlaceholder(/enter latitude/i),
    page.getByPlaceholder(/latitude/i),
    page.getByLabel(/latitude/i),
  );
  const longitude = await firstVisible(
    page.getByPlaceholder(/enter longitude/i),
    page.getByPlaceholder(/longitude/i),
    page.getByLabel(/longitude/i),
  );
  if (!latitude || !longitude) {
    await fs.mkdir(path.join(ROOT, 'output'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'output', 'goto-inputs-not-found.png') }).catch(() => undefined);
    throw new Error('Could not find visible latitude/longitude fields after selecting Goto. Screenshot saved to output/goto-inputs-not-found.png.');
  }
  console.log('Filling coordinates from config/search.json…');
  await latitude.fill(String(coordinates.lat));
  await longitude.fill(String(coordinates.long));

  const goButton = await firstVisible(
    page.getByRole('button', { name: /^go\s*to$/i }),
    page.getByText(/^go\s*to$/i),
  );
  if (!goButton) {
    await fs.mkdir(path.join(ROOT, 'output'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'output', 'goto-button-not-found.png') }).catch(() => undefined);
    throw new Error('Could not find the visible Go To button. Screenshot saved to output/goto-button-not-found.png.');
  }
  console.log('Submitting Go To…');
  await goButton.click();
  console.log('Waiting for parcel information…');

  await page.waitForFunction(
    () => {
      const body = document.body.innerText;
      return /Land Parcel Information|no parcel|no record|not found/i.test(
        body,
      );
    },
    undefined,
    { timeout: 90_000 },
  );

  const bodyText = await page.locator("body").innerText();
  const runTag = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshot = path.join(
    SCREENSHOT_DIR,
    `${coordinates.lat}_${coordinates.long}_${runTag}.png`,
  );
  const screenshotRelative = path
    .relative(ROOT, screenshot)
    .replace(/\\/g, "/");
  if (
    /no parcel|no record|not found/i.test(bodyText) &&
    !/Land Parcel Information/i.test(bodyText)
  ) {
    await closeFilter();
    await waitForMapTiles(page);
    await saveScreenshot(page, screenshot);
    return {
      input: coordinates,
      areaType: "Rural",
      district: "",
      taluk: "",
      village: "",
      villageLgdCode: "",
      rWard: "",
      rBlock: "",
      ulpin: "",
      centroid: "",
      surveyNumber: "",
      subDivision: "",
      screenshot: screenshotRelative,
      status: "not_found",
    };
  }

  await closeFilter();
  await page
    .getByText(/Land Parcel Information/i)
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });

  await waitForMapTiles(page);

  await saveScreenshot(page, screenshot);
  return parcelFromText(bodyText, coordinates, screenshotRelative);
}

async function main(): Promise<void> {
  const credentials = await readJson<Credentials>(CREDENTIALS_PATH);
  const { coordinates } = await readJson<SearchConfig>(SEARCH_PATH);
  if (!credentials.mobile || !credentials.password)
    throw new Error(
      `Add mobile and password to ${path.relative(ROOT, CREDENTIALS_PATH)}.`,
    );
  if (
    !Number.isFinite(coordinates?.lat) ||
    coordinates.lat < -90 ||
    coordinates.lat > 90 ||
    !Number.isFinite(coordinates?.long) ||
    coordinates.long < -180 ||
    coordinates.long > 180
  ) {
    throw new Error(
      `Enter valid decimal coordinates in ${path.relative(ROOT, SEARCH_PATH)}.`,
    );
  }

  await Promise.all([
    fs.mkdir(PROFILE_PATH, { recursive: true }),
    fs.mkdir(SCREENSHOT_DIR, { recursive: true }),
    fs.mkdir(RESULTS_DIR, { recursive: true }),
  ]);
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(SITE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (!/map-viewer/i.test(page.url()))
      await waitForHumanLogin(context, page, credentials);
    await closeInitialLayersPanel(page);
    const result = await searchParcel(page, coordinates);
    const name = `${coordinates.lat}_${coordinates.long}`;
    const resultPath = path.join(RESULTS_DIR, `${name}.json`);
    await fs.writeFile(
      resultPath,
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    console.log(`${result.status}: ${path.relative(ROOT, resultPath)}`);
    if (result.screenshot) console.log(`Screenshot: ${path.resolve(ROOT, result.screenshot)}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
