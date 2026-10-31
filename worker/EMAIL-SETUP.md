# Email notifications - setup

The app already shows notifications in the bell. This adds **email** for the ones people haven't
looked at after ~5 minutes (assigned to you, review requests, @mentions, blocked tasks, and the
weekly report for owners/admins). It runs as its own small Worker (`email-worker.js`), separate
from the AI one, because it needs a Google service account that can read the database.

It sends **nothing** until all three of these are set: `EMAIL_FROM`, `RESEND_API_KEY`,
`FIREBASE_SERVICE_ACCOUNT`. So deploying it early is safe.

Nothing here can be done from inside a coding assistant - it needs your own accounts.

## 1. A way to send mail (Resend), click by click

Resend's labels move around now and then; if a button has a slightly different name, look for the closest one.

**Make the account (free)**
1. Go to https://resend.com and click **Get Started** / **Sign up**.
2. Sign up with Google, GitHub, or an email address. If you used an email address, open the confirmation email and click the link.
3. You land on the dashboard. The left menu has **Emails**, **Domains**, **API Keys** and **Logs**.

**Get the API key (this is the secret the worker needs)**
4. Click **API Keys** in the left menu, then **Create API Key**.
5. Name: `todo-email-worker`. Permission: **Sending access**. Domain: **All domains** (you can narrow it later). Click **Add**.
6. The key (starts with `re_`) is shown **once**. Copy it now.
7. In your terminal:
   ```
   cd worker
   npx wrangler secret put RESEND_API_KEY -c wrangler-email.toml
   ```
   Paste the key and press Enter. Don't save it in any file.

**Option A - a quick test with no domain**
8. In `wrangler-email.toml` set `EMAIL_FROM = "To-Do List <onboarding@resend.dev>"`.
   Resend's shared test address only delivers to the email address of your own Resend account (check their docs if that ever changes), so use it to prove the setup works, not for your team.

**Option B - real use for your team (needs a domain you control)**
8. Click **Domains** -> **Add Domain**. Type your domain (a subdomain such as `mail.yourdomain.com` keeps it separate from your website's email). Pick the region closest to you, click **Add**.
9. Resend shows a short list of DNS records (a couple of TXT records for SPF and DKIM, and an MX record for bounces). Keep this page open.
10. In another tab, open the DNS settings of wherever you bought the domain and add each record exactly as shown (type, name, value). On Cloudflare: your domain -> **DNS** -> **Records** -> **Add record**; for any CNAME set the proxy to **DNS only** (grey cloud). Resend also offers an automatic setup for some providers; use it if it appears.
11. Back in Resend click **Verify DNS Records**. It can take a few minutes, sometimes a few hours. Wait until the domain says **Verified**.
12. In `wrangler-email.toml` set `EMAIL_FROM = "To-Do List <notifications@yourdomain.com>"` (any name at your verified domain works).

**Free-tier limits:** about 100 emails a day, 3,000 a month, and one domain. Plenty for six people.

### Do I really need a domain? Can I get one free?
- For email to your whole team, yes: Resend (like every sender) must be allowed to sign mail as your domain.
- **Free:** if you are a student, the GitHub Student Developer Pack includes a free one-year `.me` domain through Namecheap (claim it from https://education.github.com/pack after GitHub verifies you). It renews at the normal price after that year.
- **Otherwise it is a few dollars a year.** Cloudflare Registrar sells domains at cost (about $10 a year for `.com`) and you already use Cloudflare. Namecheap and Porkbun sell some endings for a dollar or two in the first year, but avoid the cheap spammy ones (`.xyz`, `.top`, `.click`): they are often sent to spam.
- Free "subdomain" services (eu.org, DuckDNS, js.org and the like) usually do not let you add the mail records, or are so widely abused that mail from them lands in spam. Not recommended.
- Prices change, so check the registrar's page before buying.

## 2. A Google service account (so the worker can read notifications)

1. Google Cloud Console (same project as Firebase, `todo-list-507018`) -> IAM & Admin ->
   Service Accounts -> **Create service account** (name it e.g. `email-worker`).
2. Give it exactly TWO roles, nothing else: **Cloud Datastore User** (reads notifications and saves its place) and **Firebase Authentication Viewer** (looks up each person's real, verified email address).
3. Open it -> Keys -> Add key -> Create new key -> JSON. A file downloads.
4. Store the whole file's contents as a secret, then delete the downloaded file:
   ```
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT -c wrangler-email.toml
   ```
   (paste the JSON, press Enter). Never commit that file.

## 3. One Firestore index

The job asks for "notifications created in the last while" across all users, which needs a
collection-group index (a one-time click):

Firebase console -> Firestore -> Indexes -> **Single field** -> Add exemption:
- Collection ID: `notifications`
- Field: `createdAt`
- Query scope: **Collection group**, Ascending

(If you skip it, the first run logs an error with a link that creates it for you.)

## 4. Deploy

```
cd worker
npm install
npx wrangler deploy -c wrangler-email.toml
```
That prints the worker's address, like `https://todo-email.<you>.workers.dev`.

## 5. Tell the app where it is

Open `settings.js` in the project root and set `EMAIL_WORKER_URL` (near the top of
`refreshAccountFields`) to that address, then publish the site as usual. Now Settings ->
**Send me a test email** works. Seeing the test email proves the sender setup; the Google part
is proven the first time a real notification goes out.

## Who gets email (important)

- Only people whose email address is **verified**. The address always comes from Firebase Auth, never from a profile. People who sign in with Google are verified automatically. People who signed up with an email and password get a verification link when they sign up (Settings has buttons to resend it and to check it) and get no email until they confirm it. This stops anyone signing up with somebody else's address to make us email them.
- Teammates' words are never trusted in an email: the sentence at the top of each item uses the app's own wording for that kind of event, every web address in someone else's text is replaced with "[link removed]", and everything is HTML-escaped.

## How it behaves

- Runs every 10 minutes (the `crons` line in `wrangler-email.toml`).
- Only emails notifications that are still **unread after 5 minutes**, so anyone using the app
  never gets an email about something they have already seen.
- One email per person per run (items batched), at most 12 listed.
- First run starts from "now": it never emails old notifications.
- People can switch it off in Settings (`emailNotifications` on their profile).
- Progress is stored in one Firestore document, `system/emailCursor`, so nothing is sent twice.
- Watch it live with `npx wrangler tail todo-email`.

## Free-tier limits

Resend's free plan allows about 100 emails a day. For a team of six that is plenty.
