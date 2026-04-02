Great, I have a clear picture now. Here's a comprehensive prompt you can use to kick off this scraping project:

---

## 🗂️ Web Scraping Project Prompt

**Project Goal:**
Scrape the EUDAMED Economic Operators registry and export structured data into an Excel file.

---

**Tech Stack:**
- Node.js
- Puppeteer (for browser automation & SPA rendering)
- Cheerio (for HTML parsing)
- ExcelJS or xlsx (for Excel export)

---

**Target Website:**
- **List page:** `https://ec.europa.eu/tools/eudamed/#/screen/search-eo?countryIso2Code=US&paging={"pageSize":50,"pageIndex":0}&sorting={"sortField":"srn","sortDirection":"asc"}&submitted=true`
- **Detail page example:** `https://ec.europa.eu/tools/eudamed/#/screen/search-eo/51fd1857-427d-467d-ada7-188ae4240510`

---

**Scraping Logic:**

1. **Paginate through the list page** — increment `pageIndex` until no more records are returned. Each page returns 50 records.
2. **From each row in the table, extract:**
   - Actor ID / SRN
   - Name
   - Abbreviated Name
   - City Name
3. **For each row, click `button[aria-label="View detail"]`** (or construct the detail URL using the record UUID) to open the detail page.
4. **From each detail page, extract:**
   - Actor Address (full address as one field)
   - Contact: Email
   - Contact: Telephone Number
   - Contact: Website
   - Competent Authority: Name
   - Competent Authority: Address
   - Competent Authority: Country
   - Competent Authority: Email
   - Competent Authority: Telephone Number

---

**Excel Output Columns (in order):**

| # | Column Name |
|---|-------------|
| 1 | Actor ID / SRN |
| 2 | Name |
| 3 | Abbreviated Name |
| 4 | City |
| 5 | Actor Address |
| 6 | Email |
| 7 | Telephone Number |
| 8 | Website |
| 9 | CA Name |
| 10 | CA Address |
| 11 | CA Country |
| 12 | CA Email |
| 13 | CA Telephone Number |

---

**Important Technical Considerations:**
- The site is an Angular SPA — use Puppeteer and **wait for network idle / specific DOM selectors** before scraping, not just `DOMContentLoaded`
- Add **random delays (1–3s)** between detail page requests to avoid rate limiting
- The page uses Angular, wait for the table rows to appear using a specific CSS selector before parsing
- Implement **retry logic** (3 attempts) for failed page loads
- Save progress incrementally (e.g., every 50 records) to avoid data loss on crashes
- Log skipped/failed records to a separate `errors.log` file

---

Need to add more columns into the output file. In the Detail page under h2#devices contains Devices section. There's a anchor tag with text " View Economic Operator devices". Clicking this link will take the user to Device list page which has Device table. This table has the similar structure as the List page. We're on interested in one Device even if the table has more than one devices listed. Each row has `button[aria-label="View detail"]`. Clicking this button will take the user to Device Detail page. We need the following columns from this page;
  - Device name
  - Nomenclature code(s) - can have more than one value, take all, separate by new line
  - Applicable legislation 
  - Risk class
  - Presence of human tissues or cells or their derivatives

Append these columns to the existing dataset

Have Node scraper agent implement more - After Scraping the info of the first device listed. If there's more than 1 record in the DEvice list page then look up if there's a record with a different Risk class. If a record with a different Risk class exists, scrape the info of that record. Prepend the column names of this record with "Device 2 - ". If not, all Device 2 fields should be blank. Risk class info is avaiable in the Device list page.


have node scraper fix following bugs in detail page fields;
- AR Organisation name - info is in siblings of h2#authorised-representative-person + div, look for dd element next to dl.row.ng-star-inserted > dt text="Organisation name"
- AR Phone - same as above with dt text=" Telephone number"
- AR Email - same as above with dt text="Email"

- Device name => line 68 Device name label, line 69 device name value
- Nomenclature code(s) => line 105 label, line 106 Nomenclature code(s) value
- Applicable legislation => line 46 label, line 47 Applicable legislation value
- Risk class => line 54 label, line 55 Risk class value
- Presence of cells => line 71 label, line 72 value
have node scraper apply the fix the device columns.