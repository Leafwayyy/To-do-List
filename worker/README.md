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

## If this ever needs real per-user rate limiting

v1 deliberately skips it - see the comments in `brain-dump-worker.js`. Token
verification stops unauthenticated traffic, and Gemini's own free-tier daily
request ceiling is the practical backstop for now. If this app gets real
traffic, a Durable Object (or Workers KV, accepting its 1,000-writes/day-total
free-tier ceiling) is the upgrade path for a genuine per-user daily cap.
