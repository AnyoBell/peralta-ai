# Peralta AI API (Cloudflare Worker)

One Worker that powers the site when it runs on GitHub Pages:

- **Chat** with an open model on Workers AI. The system prompt and rate limits live here, not in the browser. Chat text is never stored.
- **Analytics**: anonymous, allowlisted usage events in a private D1 database.
- **Your data**: students can view, download and delete their own records.
- **Insights**: live and aggregate stats plus a CSV export, unlocked with your admin token. Totals only, never individual students.
- **Optional sign-in** with an approved school email (default `cc.peralta.edu`) and a 6-digit emailed code. Emails are stored only as a keyed hash.
- **Leaderboard** ranked by learning outcomes: 100 points per module passed, up to 50 more per module for the best quiz score, up to 50 from the game.

## Deploy (free Cloudflare tier)

From this `api/` folder:

```bash
npx wrangler login
npx wrangler d1 create peralta-ai                    # copy the database_id into wrangler.toml
npx wrangler d1 execute peralta-ai --remote --file=schema.sql
npx wrangler secret put ADMIN_TOKEN                  # long random string: unlocks Insights
npx wrangler secret put IP_SALT                      # another long random string
npx wrangler secret put EMAIL_KEY                    # another one; NEVER change it later
npx wrangler deploy                                  # prints your Worker URL
```

Make a random string with `openssl rand -hex 32`. Keep the admin token somewhere safe (a password manager). Never commit it.

Then in `site/index.html`, set:

```js
const API_URL="https://peralta-ai-api.YOURNAME.workers.dev";
```

Commit and push. Open the site with `#insights` at the end of the URL to show the Insights tab, and enter your admin token there.

## Sending sign-in codes

Until you set up a sender, codes are written to your Worker logs only, so sign-in works for you (for testing) but not for students. Watch the logs with:

```bash
npx wrangler tail
```

When you're ready, pick one and set `EMAIL_FROM` in `wrangler.toml`:

- **Cloudflare Email Service (beta):** the sending domain must use Cloudflare DNS and be onboarded under Email > Email Sending. Uncomment the `[[send_email]]` block in `wrangler.toml`.
- **Resend:** verify a domain at resend.com, then `npx wrangler secret put RESEND_API_KEY`.

Sending from an official Peralta address needs Peralta IT to authorize the domain for whichever service you use.

`EMAIL_KEY` scrambles email addresses before they're stored. If it ever changes, existing students get new, empty accounts the next time they sign in, so keep it safe and never rotate it casually.

## Settings (`wrangler.toml`)

| Setting | Default | What it does |
|---|---|---|
| `ALLOWED_ORIGIN` | `https://anyobell.github.io` | Only this site can call the API |
| `MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | Any Workers AI text model ID |
| `MSGS_PER_ID_PER_DAY` | 60 | Chat messages per student browser per day |
| `MSGS_PER_IP_PER_DAY` | 2000 | High on purpose: campus Wi-Fi shares one IP |
| `MSGS_PER_DAY_TOTAL` | 1500 | Site-wide daily cap that protects your budget |
| `RETENTION_DAYS` | 180 | Raw events older than this are deleted daily |
| `ALLOWED_EMAIL_DOMAINS` | `cc.peralta.edu` | Email domains allowed to sign in (comma-separated) |
| `EMAIL_FROM` | empty | Sender address for codes; empty means codes go to the logs |

Workers AI includes a free daily allowance. On the Workers Free plan, chat stops for the day once it's used up (students see a friendly message). On Workers Paid, usage past the allowance is billed, so keep `MSGS_PER_DAY_TOTAL` in line with your budget.

## Test locally

```bash
npx wrangler d1 execute peralta-ai --local --file=schema.sql
npx wrangler dev --var MOCK_AI:1 --var DEV_RETURN_CODE:1 --var ALLOWED_ORIGIN:http://localhost:8000
```

`MOCK_AI` returns a fake streamed reply so you can test without using AI credits. `DEV_RETURN_CODE` puts sign-in codes in the API response. Never set either in production.

If you already deployed the earlier version, re-run the `d1 execute ... --remote --file=schema.sql` line: it only adds the new tables.

## Data stored

See [`../docs/PRIVACY.md`](../docs/PRIVACY.md). Events are validated against the allowlist in `src/index.js`. To track something new, add it there first.
