# Peralta AI privacy notice

*Draft for review by Peralta Community College District before launch.*

Peralta AI is a free study site for Peralta students. It is also a lesson in how data works, so this notice explains in plain language what the site records, why, and how to delete it. Students can see the same information, and their own records, on the **Your data** tab.

## Your anonymous ID

The first time you visit, your browser creates a random code (for example `3f2a9c1e-…`) and stores it on your device. Everything the site records about you is filed under that code.

- It is **not** your name, email, phone number or student ID, and it is not linked to any of them.
- It is **pseudonymous, not identity-free**: anyone who uses your browser could see the code, and in rare cases patterns of use could hint at who someone is. That is why we keep records small and delete them on a schedule.
- Clearing your browser data, or using another device or browser, gives you a new code.

## What we record

| What | Example | Why |
|---|---|---|
| Visits and tabs opened | Opened Learn | See which parts of the site get used |
| Modules and quizzes | Started module 2, scored 10 of 12 | Find lessons that are too hard or confusing |
| Module ratings | Rated module 1: 4 of 5 | Know what to improve |
| Game progress | Reached round 8, 95 XP | See where players stop |
| Prompt library actions | Saved a prompt | Learn which features matter |
| Chat activity | Sent a medium-length message; reply took 3 seconds | Keep the chat fast and within budget |

Each record is the anonymous ID, the event name, a few fixed fields like those above, and the time. The server rejects anything outside this list.

## What we never record

- What students type in chat, or the AI's replies
- Names, emails, phone numbers or student ID numbers
- IP addresses. The server makes a scrambled (salted, hashed) version that changes every day, uses it only to limit spam and abuse, and deletes it after two days.
- Activity on other websites

## Optional sign-in with a school email

Students can sign in with an approved Peralta email address (for example `student@cc.peralta.edu`) to join the campus leaderboard and keep their progress across devices. Signing in is never required to use the site.

- **How it works:** the student enters their school email and receives a 6-digit code that expires in 10 minutes. There are no passwords. Only approved email domains are accepted, and attempts and code requests are limited.
- **What's stored for an account:** a scrambled version of the email (a keyed HMAC, not the address itself), the email domain, the nickname the student chooses, and their best quiz score per module and best game XP. Codes and sign-in tokens are stored only as hashes and expire.
- **What isn't:** the email address itself. It is used once to send the code and then discarded.
- **Separation:** usage counts stay under the browser's anonymous ID and are not linked to the account.
- **Leaderboard:** shows only nicknames, points and modules passed. Students are told not to use their real name.
- **Who sees it:** staff see totals only (for example, how many signed-in students have passed each module). The Insights page has no way to look up an individual student.
- **Deleting:** students can delete their account, nickname and scores at any time from the Sign in tab.

Leaderboard scores are calculated from quiz results reported by the student's browser, so they are meant for friendly competition and should not be used for grades.

## The AI chat

To write a reply, a student's messages are sent to an open AI model (Meta Llama) running on Cloudflare Workers AI. Peralta AI does not store chat messages, and chats disappear when the page is closed. Cloudflare processes the messages to generate the reply under its own terms.

## Third parties

- **GitHub Pages** hosts the website.
- **Cloudflare** runs the API, the AI model, and the private database (D1) where usage records are stored.

Both receive the visitor's IP address as part of delivering the site, as any web host does. No advertising or tracking services are used, and data is never sold.

## Who can see the data

Only the Peralta AI team, through a token-protected Insights page, mostly as totals (for example, "60% of students who start module 2 pass it"). Browsers can write records but can never read anyone else's.

## How long we keep it

Raw records are deleted automatically after **180 days**. Rate-limit counters are deleted after two days.

## Your choices

On the **Your data** tab, students can:

- See every record stored under their ID
- Download their records as a file
- Delete all their records immediately (they get a new ID afterward)
- Turn off usage recording for their browser

## Contact

Questions about this notice: use the contact form on the site's Help tab.
