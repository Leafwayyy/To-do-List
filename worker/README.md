# Brain Dump Worker - deploy steps

This is the small Cloudflare Worker that holds the Gemini API key and verifies
every request is a real signed-in user of this app before spending one. None
of this can be set up from inside a coding assistant - it needs your own
accounts/browser login. One-time setup:

1. **Get a Gemini API key** - free, no card required, from
   [Google AI Studio](https://aistudio.google.com/apikey).

2. **Install dependencies** (from this `worker/` directory):
   ```
   npm install
   ```

3. **Log in to Cloudflare** (opens a browser):
   ```
   npx wrangler login
   ```
   (Free Cloudflare account if you don't have one already - no card required.)

4. **Set the Gemini key as an encrypted secret** (never goes in a file, never
   gets committed):
   ```
   npx wrangler secret put GEMINI_API_KEY
   ```
   Paste the key from step 1 when prompted.

5. **Deploy:**
   ```
   npx wrangler deploy
   ```
   This prints the Worker's URL, something like
   `https://todo-brain-dump.<your-subdomain>.workers.dev`.

6. **Wire the URL into the app** - open `brain-dump.js` in the project root
   and set `BRAIN_DUMP_WORKER_URL` (near the top of the file) to that URL.
   Redeploy the site as usual.

## If you ever change domains

`wrangler.toml`'s `ALLOWED_ORIGINS` is a comma-separated allowlist the Worker
checks incoming requests' `Origin` header against. It already includes the
GitHub Pages origin and `localhost:8000` for local testing. Add any other
origin you serve the app from, then `npx wrangler deploy` again.

## Per-user rate limiting

Built in - see `checkAndIncrementRateLimit`/`DAILY_MESSAGE_LIMIT_PER_USER` in
`brain-dump-worker.js`. Each signed-in user is capped at a fixed number of
Brain Dump messages per day (Workers KV, `RATE_LIMIT_KV` binding), independent
of whatever the Gemini API's own quota allows. The point isn't backstopping
the free tier - it's bounding worst-case PAID cost exposure from a single
abused, compromised, or scripted account once billing is enabled on the
Gemini API key and its free-tier ceiling stops being a hard cost cap on its
own.

If the `RATE_LIMIT_KV` namespace ever needs recreating (a new Cloudflare
account, a fresh project, etc.):
```
npx wrangler kv namespace create RATE_LIMIT_KV
```
then paste the printed `id` into the `[[kv_namespaces]]` block in
`wrangler.toml` and redeploy. Workers KV free tier (100k reads/day, 1k
writes/day) is far more than this app needs at its current scale - a
Durable Object (needs the paid Workers plan) would be the eventual upgrade
if traffic ever grew enough for KV's eventual consistency or its write
ceiling to actually matter.
