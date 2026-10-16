# Tamil Nilam land parcel extension

The `extension/` directory contains an early Manifest V3 extension scaffold. Its popup reads the sample coordinate from `extension/search.json`; the values can also be edited in the popup and are retained for the next search.

## Credentials

`extension/credentials.json` is a local-only placeholder and is excluded from Git. The current extension does not automate login, and CAPTCHA must be solved by the user. Do not put credentials into a tracked extension file: browser extension package contents are readable by users. If credentials are later added locally, keep the file untracked and never publish the loaded extension with those credentials included.

## Current state

Search opens or focuses the Tamil Nilam page and passes the coordinates to the content script when the map viewer is already open. The live site selectors, Goto interaction, parcel extraction, and screenshot capture still need implementation and validation against the viewer. The example coordinate is Amuthurmedu: `13.100889, 80.057889`.

Load `extension/` as an unpacked extension in Chrome or Edge to inspect the popup scaffold.
