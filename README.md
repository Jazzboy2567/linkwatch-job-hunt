# Job Hunt — a LinkWatch extension

Your whole job-hunt loop in one LinkWatch extension. It is both a **ranker** and a
**panel**, so one install does three things:

- **Ranks** every scraped job against your resume (fetching the real description when
  it can), floating the best entry-level matches to the top and tagging each one
  entry-level / senior / clearance / no-login.
- **Finds your skill gaps** — the in-demand skills the postings ask for that your
  resume doesn't list yet, so you know what to learn next.
- **Tracks applications** — a Job Hunt sidebar tab with what you've applied to (status,
  date, notes, CSV export), the resume it scores against (view + paste to update), and
  your skill gaps. Adds a **+ Track** button to each result row.

Your resume and application list never leave this machine. The only network calls are
to the public job pages it fetches to read a description.

## Install

Clone this repo into your LinkWatch user-extensions folder as `job-hunt`:

```
git clone <this-repo-url> "%APPDATA%\linkwatch\extensions\job-hunt"
```

Then enable **Job Hunt** in LinkWatch → Extensions. Click **Update** on its card any
time to pull the latest (the app runs `git pull --ff-only` on this folder).

## Your resume

Drop a plain-text `resume.txt` in this folder, or paste your resume into the **Resume**
tab in the app (it writes `resume.txt` for you). The ranker reads it, scores jobs by how
well they match the skills it finds, and the **Skill Gaps** tab shows what's missing.
With no resume it falls back to the generic weights in `config.json`.

## Public vs private copy

This extension is maintained as two repos so a personal resume never reaches a public
repo:

- **Public** (`linkwatch-job-hunt`) — the generic, shareable code. `resume.txt` is
  gitignored here; only `resume.txt.example` ships.
- **Private** (`linkwatch-job-hunt-private`) — your own copy, which additionally
  commits your tailored `resume.txt`. Your machine clones **this** one, so the app's
  Update button pulls your personalized copy.

Code changes are pushed to both; the resume only ever lives on the private side.

## Tuning

Edit `config.json` (skills vocabulary, weights, title/seniority/clearance signals,
fetch limits, `gapTopN`). After editing, click **Reload extensions** in Settings — no
restart needed.
