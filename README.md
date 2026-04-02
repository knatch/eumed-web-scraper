# EUDAMED Economic Operators Scraper

A Node.js scraper for the [EUDAMED](https://ec.europa.eu/tools/eudamed/) Economic Operators (EO) public registry. It navigates the Angular SPA, intercepts the underlying REST API responses, and exports all operator records — including competent authority, authorised representative, importer, and device detail fields — to both Excel (`.xlsx`) and CSV.

## What it collects

For each economic operator record:

| Column | Description |
|---|---|
| Actor ID / SRN | Unique Single Registration Number |
| Name | Full legal name |
| Abbreviated Name | Short name / trade name |
| Country | Full country name (resolved from country code) |
| City | City of registration |
| Actor Address | Registered geographical address |
| Email | Contact email |
| Telephone Number | Contact phone number |
| Website | Company website |
| CA Name | Competent Authority name |
| CA Address | Competent Authority address |
| CA Country | Competent Authority country |
| CA Email | Competent Authority email |
| CA Telephone Number | Competent Authority phone |
| AR Organisation Name | Authorised Representative organisation name |
| AR Phone | Authorised Representative phone |
| AR Email | Authorised Representative email |
| Importer Organisation Name | Importer organisation name |
| Importer Email | Importer email |
| Device Name | First registered device name |
| Nomenclature Code(s) | Device nomenclature / GMDN codes |
| Applicable Legislation | EU regulation (e.g. MDR, IVDR) |
| Risk Class | Device risk classification |
| Human Tissues/Cells | Whether the device contains human tissues or cells |

## Prerequisites

- **Node.js** 18 or later (built-in `fetch` is used; earlier versions are not supported)
- **npm** 9 or later
- Google Chrome or Chromium will be downloaded automatically by Puppeteer on first install

## Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd eudamed-scraper

# 2. Install dependencies (downloads Puppeteer's bundled Chromium)
npm install

# 3. Configure environment variables
cp .env.example .env
# Then edit .env and set COUNTRY_CODE to the country you want to scrape
```

## Environment variables

All configuration lives in `.env`. See `.env.example` for a fully-annotated template.

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `https://ec.europa.eu/tools/eudamed` | EUDAMED portal base URL (no trailing slash) |
| `COUNTRY_CODE` | `US` | ISO 3166-1 alpha-2 country code to scrape |
| `PAGE_SIZE` | `50` | Records per list page (EUDAMED API max is 50) |
| `OUTPUT_FILE` | `./output/eudamed_export_<CC>.xlsx` | Excel output path; auto-derived from `COUNTRY_CODE` if unset |
| `CSV_FILE` | `./output/eudamed_export_<CC>.csv` | CSV output path; auto-derived from `COUNTRY_CODE` if unset |
| `STAGING_FILE` | `./output/staging.jsonl` | Append-only staging file used for crash recovery |
| `CHECKPOINT_FILE` | `./output/progress.json` | Checkpoint state file |
| `HEADLESS` | `true` | Set to `false` to watch the browser window during a run |
| `MIN_DELAY_MS` | `1000` | Minimum delay between detail page requests (ms) |
| `MAX_DELAY_MS` | `3000` | Maximum delay between detail page requests (ms) |
| `MAX_RETRIES` | `3` | Retry attempts per page or detail request before skipping |
| `CHECKPOINT_INTERVAL` | `50` | Save a checkpoint every N records |
| `LOG_FILE` | `./logs/errors.log` | Error and warning log path |

## Running the scraper

```bash
# Scrape the country set in .env
npm start

# Or call the entry point directly
node src/index.js
```

## CLI flags

Flags override the corresponding `.env` / `config.js` values for a single run without editing any file.

| Flag | Example | Description |
|---|---|---|
| `--country <CC>` | `--country DE` | ISO 3166-1 alpha-2 country code |
| `--output <path>` | `--output ./out/de.xlsx` | Override Excel output file path |
| `--headless <bool>` | `--headless false` | Show/hide the browser window (`true`/`false`) |
| `--dry-run` | `--dry-run` | Stop after 3 records (useful for smoke-testing) |

Examples:

```bash
# Scrape Germany
node src/index.js --country DE

# Scrape France with a visible browser window
node src/index.js --country FR --headless false

# Quick smoke test — scrapes 3 records then stops
node src/index.js --dry-run

# Combined
node src/index.js --country GB --output ./output/uk_operators.xlsx
```

## Output files

After a successful run the `output/` directory contains:

| File | Description |
|---|---|
| `eudamed_export_<CC>.xlsx` | Excel workbook with a styled, frozen header row |
| `eudamed_export_<CC>.csv` | UTF-8 BOM CSV (opens cleanly in Excel) |

Both files contain identical data. The `output/` directory is git-ignored — only the code is committed.

## Checkpoint and resume

The scraper writes two recovery files to `output/` during a run:

- **`staging.jsonl`** — every successfully scraped record appended as a JSON line
- **`progress.json`** — checkpoint state: last completed page index, last completed row index, total records written, and a timestamp

If the scraper is interrupted (crash, Ctrl+C, SIGTERM), it saves a checkpoint before exiting. On the next run it automatically detects these files, re-hydrates the in-memory workbook from `staging.jsonl`, and resumes from the saved page/row position — no records are re-scraped and no records are lost.

Checkpoints are saved:
- Every `CHECKPOINT_INTERVAL` records (default: every 50)
- On Ctrl+C / SIGTERM
- On any unexpected fatal error

## Resetting and starting fresh

To discard all checkpoint and staging state and start from page 0:

```bash
rm -f output/progress.json output/staging.jsonl
```

To also remove the previous export files:

```bash
rm -f output/eudamed_export_*.xlsx output/eudamed_export_*.csv
```

The `logs/` directory accumulates error logs across runs. To clear them:

```bash
rm -f logs/errors.log
```

## Project structure

```
eudamed-scraper/
├── src/
│   ├── index.js                    # Main orchestration and pagination loop
│   ├── config.js                   # Centralised config (reads from .env)
│   ├── browser.js                  # Puppeteer browser/page lifecycle
│   ├── scraper/
│   │   ├── listPage.js             # List page navigation + API interception
│   │   ├── detailPage.js           # Actor detail page extraction
│   │   ├── deviceDetailPage.js     # Device detail page extraction
│   │   └── selectors.js            # CSS/Angular Material selectors
│   ├── exporter/
│   │   ├── excel.js                # ExcelJS workbook builder
│   │   └── csv.js                  # CSV stream writer
│   └── utils/
│       ├── logger.js               # Winston logger (console + file)
│       ├── progress.js             # Checkpoint and staging file I/O
│       ├── retry.js                # withRetry() helper
│       ├── delay.js                # randomDelay() helper
│       └── countryNames.js         # ISO country code → full name mapping
├── .env.example                    # Environment variable template (committed)
├── .env                            # Local config (git-ignored)
├── .gitignore
└── package.json
```

## Troubleshooting

**Puppeteer fails to launch on Linux / CI**

Add the `--no-sandbox` flag. The scraper already passes this by default in `browser.js`. If you are running in a Docker container also ensure `--disable-dev-shm-usage` is set (it is).

**Scraper stops early with "consecutive page failures"**

The scraper stops after 3 consecutive page failures, assuming it has reached the end of the data. If this happens unexpectedly, check `logs/errors.log` for the underlying error and consider increasing `MAX_RETRIES` in `.env`.

**Output files are empty / header only**

Run with `--headless false` to watch the browser. If Angular never renders the search results, the EUDAMED site may have changed its URL structure. Check the console output for `[list intercept]` log lines — if none appear, the API path has changed.

**Resuming picks up the wrong position**

Delete `output/progress.json` and `output/staging.jsonl` and restart. The scraper will re-scrape from page 0.
