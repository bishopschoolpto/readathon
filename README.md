# Bishop School Readathon

A school-wide readathon app for **readathon.bishopschoolpto.com**:

- **Students** get a private link (`/s/<token>`) where they log daily minutes, fix past days, record the book they're reading and books they've finished, set a goal, and choose what their donation page shows.
- **Donors** visit a short link (`/d/<CODE>`) showing the student, their progress, and their bookshelf with covers from Open Library, plus the PTO's donation widget.
- **Organizers** use `/admin` to sync the roster, hand out links (CSV or printable slips), see totals by class, change settings, and edit the donation widget HTML with template values like `{studentName}`.
- **The home page** (`/`) shows school-wide totals and an optional class leaderboard.

## How it fits together

```
readathon.bishopschoolpto.com  (static files in public/)
        │  fetch, JSON
        ▼
Google Apps Script web app      (apps-script/, deployed with clasp)
        │
        ├── Roster spreadsheet  ← the school's data; the app only reads it
        └── Data spreadsheet    ← everything the app writes
```

All app logic is in `apps-script/Core.js`. Apps Script runs it, and so does the local dev server, so local behavior matches production.

### Roster spreadsheet (you maintain it)

The first tab, or the one named in `ROSTER_SHEET_NAME`, with a header row:

| Student ID | First Name | Last Name | Grade | Teacher |
|---|---|---|---|---|
| 1001 | Avery | Example | K | Ms. Rivera |

- **Student ID** is required and must be unique and stable. If you don't have school IDs, number the rows 1, 2, 3… and never reuse a number.
- Common variations are recognized, e.g. `ID`, `Student Name` (as "First Last" or "Last, First"), `Grade Level`, `Homeroom`.
- "Classmates" means students who share the same Teacher value.

### Data spreadsheet (the app maintains it)

| Tab | One row per | Columns |
|---|---|---|
| Settings | setting | key, value |
| Students | student | studentId, name/grade/teacher (for reference), private **token**, donation **code**, goal, donation-page toggles |
| Minutes | student per day | studentId, date, minutes, updatedAt |
| Books | book | bookId, studentId, title, author, status (`reading`/`finished`), coverId, isbn |

`Minutes` uses one row per student per day, so pivot tables work directly. You can add your own columns to the right; the app keeps them. Don't rename the existing headers.

## Setup

### 1. Create the Apps Script backend

```bash
npm install
npm run gas:login        # sign in with the Google account that will own the spreadsheets
npm run gas:create       # creates the Apps Script project and .clasp.json
npm run gas:push
```

The first time, enable the Apps Script API at https://script.google.com/home/usersettings.

Then open the project (`npx clasp open-script`), choose **setup** in the function dropdown, and click **Run**. Approve the permission prompt. `setup()`:

- creates a **Readathon Roster** spreadsheet with sample rows, unless you've already set `ROSTER_SPREADSHEET_ID`
- creates the **Readathon Data** spreadsheet and its tabs
- gives every roster student a token and code

The execution log at the bottom of the editor shows the spreadsheet URLs. These values live under **Project Settings → Script properties**:

| Property | Meaning |
|---|---|
| `ROSTER_SPREADSHEET_ID` | ID from the roster's URL (`/spreadsheets/d/<ID>/edit`). Set this before running `setup()` to use an existing roster. |
| `ROSTER_SHEET_NAME` | Optional tab name; defaults to the first tab. |
| `DATA_SPREADSHEET_ID` | Created by `setup()`. |
| `GOOGLE_CLIENT_ID` | OAuth client ID for organizer sign-in (next step). |

### 2. Set up "Sign in with Google" for organizers

Organizers sign in to `/admin` with Google. **Anyone who can edit the Readathon Data spreadsheet is an organizer.** To add an organizer, share the sheet with them as an editor; to remove one, unshare it. Changes take effect within 5 minutes.

To create the sign-in client (once, in the same Google account):

1. Open https://console.cloud.google.com, then create or pick a project.
2. Go to **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding"). Choose **External**, enter an app name such as "Bishop Readathon" and your email, then save. Sign-in uses only basic scopes (email, profile), so Google doesn't need to review the app.
3. Go to **Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins**, add `https://readathon.bishopschoolpto.com`.
4. Copy the client ID (`…apps.googleusercontent.com`) into two places:
   - the `GOOGLE_CLIENT_ID` script property
   - `googleClientId` in `public/config.js`

   Client IDs aren't secret.

How the server checks each admin request:

- Google confirms the ID token is genuine and unexpired.
- The token was issued to *this* client ID, so a sign-in token from another site won't work.
- The email is verified.
- The email is the data spreadsheet's owner or one of its editors.

A few cases don't work:

- Sharing with a **Google Group** doesn't grant access, because the script sees only the group's address. Share with individual people instead.
- "Anyone with the link can edit" doesn't grant access either.
- Viewers and commenters on the spreadsheet aren't organizers.

### 3. Deploy the web app

```bash
npm run gas:deploy
```

Or in the editor: **Deploy → New deployment → Web app**, *Execute as: Me*, *Who has access: Anyone*. Copy the `/exec` URL into `public/config.js`.

Ship later backend changes with `npm run gas:push && npm run gas:redeploy -- <deploymentId>`. Updating the existing deployment keeps the same URL.

Google's login isn't required for students or donors: the web app runs as you, and the spreadsheets stay private to you.

### 4. Host the site at readathon.bishopschoolpto.com

`public/` is a plain static site with no build step.

- **Cloudflare Pages or Netlify (recommended):** publish `public/`. `_redirects` maps `/s/*`, `/d/*` and `/admin` to the right pages. Add `readathon.bishopschoolpto.com` as a custom domain and create the CNAME record they give you.
- **GitHub Pages:** publish `public/`. `CNAME` is included, and `404.html` redirects the pretty URLs, since GitHub Pages has no rewrites.

### 5. Run the readathon

1. Fill in the roster. In `/admin`: set the dates, title and goal under **Settings**, then click **Sync roster** under **Students & links**. Sync again whenever students are added.
2. Give each student their private log link via **Download CSV** (e.g. for a mail merge to families) or **Print link slips**.
3. Paste your donation platform's embed code under **Donation widget** and check the preview.
4. When the readathon ends, tick **Lock reading logs** so totals stop changing.

## Donation widget templates

| Value | Example |
|---|---|
| `{studentName}` | Avery E. (format set under Settings) |
| `{studentFirstName}`, `{studentLastInitial}` | Avery, E. |
| `{studentGrade}`, `{studentTeacher}` | 3, Mr. Chen |
| `{studentCode}`, `{donationUrl}` | K7F2QM, https://readathon.bishopschoolpto.com/d/K7F2QM |
| `{totalMinutes}`, `{goalMinutes}`, `{classMinutes}` | 340, 600, 4120 |
| `{schoolName}`, `{readathonTitle}` | |

- Plain `{value}` is HTML-escaped, for text and attributes.
- `{value:url}` is URL-encoded, for query strings: `href="https://give.example/?note={studentName:url}"`.
- `{value:json}` is a quoted JS string, for inside `<script>`: `var who = {studentName:json};`.
- Unknown `{...}` is left alone, so CSS and JS braces are safe.

The widget's `<script>` tags run on the donation page, so embeds like Givebutter, Zeffy or PayPal buttons work. Widgets that rely on `document.write` won't work. Only paste code from sources you trust.

## Privacy and security

- **Private log links:** 24 random characters per student. They're never shown on donation pages, the pages send no `Referer`, and they're excluded from search engines. If one leaks, **New log link** in admin replaces it; the donation link stays the same.
- **Donation links:** they use a separate 6-character code and show only first name + last initial by default, plus whatever the student chose to show.
- **Spreadsheet safety:** all text is stored with a leading apostrophe, so student input can never become a spreadsheet formula.
- **Organizer access:** organizers are the data spreadsheet's editors, signed in with Google and checked on every admin request (see step 2). Google's ID token lasts about an hour. The browser keeps it in `sessionStorage` until the tab closes, and when it expires the page asks the organizer to sign in again.
- **Spreadsheet editors see everything:** they can read every private log link in the Students tab whether or not they use `/admin`, so share the data spreadsheet only with organizers. The roster spreadsheet is separate and can be shared more widely.

## Local development

```bash
npm run dev        # http://localhost:8082 with a fake roster and demo data
```

The console prints the admin URL and some student and donation links. Google sign-in isn't used locally. Instead, the admin page offers an email box, and any address in `DEV_ADMINS` (default `organizer@example.com`) counts as a spreadsheet editor. Data is saved in `dev/data.json`; delete that file to start over. Book search and covers use Open Library directly, so they need internet access.

```bash
npm test           # unit tests for apps-script/Core.js
npm run test:ui    # Playwright browser tests (fresh in-memory data, fixed date)
```

## Limits

Apps Script handles a school of several hundred students comfortably. Each request takes ~1–2 s, and Google allows about 30 simultaneous executions per script. Totals are cached for 60 seconds and the roster for 5 minutes, so donation pages and the home page may lag slightly behind.
