import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";

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

async function requestCaptchaFromUi(page: Page): Promise<string> {
  let resolveAnswer!: (answer: string) => void;
  const answerPromise = new Promise<string>((resolve) => {
    resolveAnswer = resolve;
  });

  await page.exposeFunction("__tngisSubmitCaptcha", (answer: string) => {
    if (typeof answer === "string" && answer.trim())
      resolveAnswer(answer.trim());
  });
  await page.evaluate(() => {
    document.getElementById("tngis-captcha-entry")?.remove();
    const style = document.createElement("style");
    style.id = "tngis-captcha-entry-style";
    style.textContent =
      "#tngis-captcha-entry{position:fixed;right:24px;bottom:24px;z-index:2147483647;width:300px;padding:16px;border:1px solid #b9cbd2;border-radius:12px;background:#fff;box-shadow:0 8px 28px #0004;color:#182b35;font:14px/1.4 Arial,sans-serif}" +
      "#tngis-captcha-entry h2{margin:0 0 6px;font-size:16px}#tngis-captcha-entry p{margin:0 0 10px;color:#4b5d66}" +
      "#tngis-captcha-entry input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #97aab2;border-radius:6px;font-size:16px}" +
      "#tngis-captcha-entry button{width:100%;margin-top:10px;padding:10px;border:0;border-radius:6px;background:#126b79;color:#fff;cursor:pointer;font-size:14px}" +
      "#tngis-captcha-entry [data-error]{min-height:18px;margin-top:6px;color:#b42318}";
    document.head.append(style);

    const panel = document.createElement("section");
    panel.id = "tngis-captcha-entry";
    panel.setAttribute("aria-label", "CAPTCHA entry");
    panel.innerHTML =
      "<h2>Enter CAPTCHA</h2><p>Read the CAPTCHA shown in the Tamil Nilam login form and type it here.</p>" +
      '<input type="text" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="CAPTCHA text" />' +
      '<div data-error role="status"></div><button type="button">Submit CAPTCHA</button>';
    document.body.append(panel);

    const captchaField = panel.querySelector("input")!;
    const error = panel.querySelector("[data-error]")!;
    const submit = () => {
      const value = captchaField.value.trim();
      if (!value) {
        error.textContent = "Enter the CAPTCHA first.";
        captchaField.focus();
        return;
      }
      const bridge = (
        window as unknown as { __tngisSubmitCaptcha?: (answer: string) => void }
      ).__tngisSubmitCaptcha;
      bridge?.(value);
      panel.remove();
      style.remove();
    };
    panel.querySelector("button")!.addEventListener("click", submit);
    captchaField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    captchaField.focus();
  });

  return answerPromise;
}

async function waitForHumanLogin(
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
  const captchaAnswer = await requestCaptchaFromUi(page);

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

async function searchParcel(
  page: Page,
  coordinates: Coordinates,
): Promise<ParcelDetails> {
  const closeFilter = await openGoto(page);
  const latitudeInput = page
    .getByPlaceholder(/enter latitude|latitude/i)
    .or(page.getByLabel(/latitude/i))
    .first();
  const longitudeInput = page
    .getByPlaceholder(/enter longitude|longitude/i)
    .or(page.getByLabel(/longitude/i))
    .first();
  await latitudeInput.waitFor({ state: "visible", timeout: 15_000 });
  await longitudeInput.waitFor({ state: "visible", timeout: 15_000 });
  const latitude = latitudeInput;
  const longitude = longitudeInput;
  if (!latitude || !longitude)
    throw new Error(
      "Could not find the Latitude and Longitude inputs in Goto.",
    );
  await latitude.fill(String(coordinates.lat));
  await longitude.fill(String(coordinates.long));

  const goButton = page
    .getByRole("button", { name: /^go\s*to$/i })
    .or(page.getByText(/^go\s*to$/i))
    .first();
  await goButton.waitFor({ state: "visible", timeout: 15_000 });
  await goButton.click();

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
    await page.screenshot({ path: screenshot, fullPage: false });
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

  await page.screenshot({ path: screenshot, fullPage: false });
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
      await waitForHumanLogin(page, credentials);
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
    if (result.screenshot) console.log(`Screenshot: ${result.screenshot}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
