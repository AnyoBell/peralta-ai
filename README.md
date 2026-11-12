# Peralta AI

An AI literacy platform for community college students, focused on academic integrity.

Built for the Peralta Community College District, it teaches students where AI help ends and cheating begins, then builds the skills to use AI well: writing strong prompts, checking AI answers, and studying with AI. Students practice in a coaching chat, a scenario game and short quizzes, and can compete on a campus leaderboard. Staff get live, anonymous outcome data showing what students are learning.

**Live site:** https://anyobell.github.io/peralta-ai/

## Features

- **Chat:** a study assistant that coaches instead of doing graded work. Runs on an open model (Meta Llama) through Cloudflare Workers AI. No download, no sign-up, and chat text is never stored.
- **Learn:** four modules (about 20 minutes each) on academic integrity, prompt structure, AI literacy and studying with AI. Each has a lesson, practice prompts, a reflection and a 12-question check. Modules unlock at 80%.
- **Play:** a 12-round scenario game with XP and levels.
- **Leaderboard:** ranked by learning outcomes. 100 points per module passed, up to 50 more per module for the best quiz score, and up to 50 from the game. Nicknames only.
- **Optional sign-in:** approved school emails (default `cc.peralta.edu`) with a 6-digit emailed code. No passwords, and email addresses are never stored.
- **Your data:** students see exactly what's recorded about them, and can download or delete it or turn recording off.
- **Insights (staff only):** live activity, a visit-to-completion funnel, module pass rates and ratings, feature use, game drop-off and a CSV export. Totals only; individual students can't be looked up.

## Repository layout

```
site/        the website: one HTML file, no build step
api/         Cloudflare Worker + D1 database: chat, analytics, sign-in, leaderboard, insights
docs/        PRIVACY.md, what is and isn't collected
collector/   legacy analytics Worker from Prompt Craft (replaced by api/)
analysis/    legacy analysis scripts from Prompt Craft
```

## Setup

### 1. Publish the site (GitHub Pages)

Repo **Settings → Pages → Source: GitHub Actions**. Pushing to `main` deploys `site/`.

### 2. Deploy the API (free Cloudflare tier)

```bash
npm install -g wrangler
cd api
wrangler login
wrangler d1 create peralta-ai                     # copy the database_id into wrangler.toml
wrangler d1 execute peralta-ai --remote --file=schema.sql
wrangler secret put ADMIN_TOKEN                   # unlocks Insights
wrangler secret put IP_SALT                       # scrambles IPs for rate limiting
wrangler secret put EMAIL_KEY                     # scrambles emails; never change it
wrangler deploy                                   # prints your Worker URL
```

Generate each secret with `openssl rand -hex 32` and keep `ADMIN_TOKEN` and `EMAIL_KEY` in a password manager. Never commit them.

### 3. Connect the site

In `site/index.html`, set:

```js
const API_URL="https://peralta-ai-api.YOURNAME.workers.dev";
```

Commit and push. Open the site with `#insights` at the end of the URL and enter your admin token to see Insights.

### 4. Turn on sign-in emails

Until an email sender is configured, sign-in codes only appear in the Worker logs (`wrangler tail`). To email them to students, set up Cloudflare Email Service or Resend. See [`api/README.md`](api/README.md).

## Settings

All in `api/wrangler.toml`. The main ones:

| Setting | Default | What it does |
|---|---|---|
| `ALLOWED_ORIGIN` | `https://anyobell.github.io` | Only this site can call the API |
| `MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | Workers AI model for chat |
| `MSGS_PER_ID_PER_DAY` | 60 | Chat messages per student browser per day |
| `MSGS_PER_DAY_TOTAL` | 1500 | Site-wide daily chat cap that protects your budget |
| `RETENTION_DAYS` | 180 | Raw usage records are deleted after this |
| `ALLOWED_EMAIL_DOMAINS` | `cc.peralta.edu` | Email domains allowed to sign in |

Full list and local testing instructions: [`api/README.md`](api/README.md).

## What gets tracked

Anonymous usage counts under a random ID made by each browser: tabs opened, modules started and passed, quiz scores, module ratings, game progress, prompt library actions, and chat timing. Never chat text, names, emails, student IDs or raw IP addresses. Events outside the server's allowlist are rejected. Details in [`docs/PRIVACY.md`](docs/PRIVACY.md), which is a draft pending Peralta's review.

## Leaderboard

Quiz scores are reported by the student's browser, so a technical student could inflate their points. That's fine for friendly campus competition. If prizes or grades ever depend on rankings, move quiz grading to the server.

## License

Code is MIT. If you want to keep the course wording and lessons all-rights-reserved while the code stays open, say so here and add a separate content license.
