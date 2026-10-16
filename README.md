# Tamil Nilam Parcel Lookup Bot

This project is a Node.js 18.20.8 and Playwright bot written in TypeScript. It reads login credentials from `config/credentials.json` and one coordinate from `config/search.json`, opens the Tamil Nilam GI Viewer in a visible browser, searches for the parcel, and saves parcel details and a screenshot.

## Setup

1. Install dependencies with `npm install`.
2. Install the Playwright browser with `npx playwright install chromium`.
3. Keep the provided login details in `config/credentials.json`. This local file is ignored by Git.
4. Set the current lookup coordinate in `config/search.json`.
5. Run `npm run search` to execute the TypeScript bot directly.

The bot fills the Public login credentials. You must complete the CAPTCHA and submit the login in the visible browser, then press Enter in the terminal. The bot continues the lookup after the map viewer opens. It saves the session profile in `data/browser-profile/` so later runs can reuse it.

Results are saved as JSON under `output/results/` and screenshots under `output/screenshots/`.

## Project source

Edit `src/bot.ts`. The bot runs from TypeScript with `tsx`; `npm run build` only type-checks the source and emits no JavaScript files.
