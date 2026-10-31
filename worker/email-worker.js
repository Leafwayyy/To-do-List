// Email worker: sends people an email about notifications they have NOT looked at.
//
// Kept as its own Worker (separate from the Gemini one in brain-dump-worker.js) on purpose:
// this one holds a Google service account that can read the database, so the AI proxy -
// which handles untrusted text all day - never gets that power.
//
// How it works (every 10 minutes, on a Cloudflare cron trigger):
//  1. Ask Firestore for notifications created since the last run that are at least 5 minutes
//     old. Waiting 5 minutes means someone who is already using the app (and sees the bell)
//     never gets an email about something they have read.
//  2. Drop the ones already read, group the rest per person, look up each person's email
//     address and whether they have email switched off, and send ONE email per person.
//  3. Remember how far it got (system/emailCursor) so nothing is ever sent twice.
//
// It does nothing until EMAIL_FROM (a sender you have verified with Resend), RESEND_API_KEY and
// FIREBASE_SERVICE_ACCOUNT are all set - see EMAIL-SETUP.md.
//
// Also: POST /test (signed-in users only) sends a test email to the caller's OWN address, so
// the Settings page can confirm that email really works.
//
// Every piece of text that came from a person (task titles, names, comments) is HTML-escaped
// before it goes into an email.

import { SignJWT, importPKCS8, jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
));

const SETTLE_MS = 5 * 60 * 1000;
const QUERY_LIMIT = 300;
const MAX_EMAILS_PER_RUN = 50;
const MAX_ITEMS_PER_EMAIL = 12;

// ---- small helpers ------------------------------------------------------------

export function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const oneLine = (value, max) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

// Text written by other people goes into an email that comes from OUR address, so it must not be
// a way to smuggle in a clickable link ("click here to verify your account"). Anything that looks
// like a web address is replaced, in both the plain and the HTML version.
const TLDS = 'com|net|org|io|co|app|dev|ly|me|xyz|ru|info|biz|us|uk|de|fr|cn|tk|top|site|online|link|click|live|cc|to|gl|gg|sh|ai|cloud|page|zip|mov';
const URLISH = new RegExp(`(?:\\b(?:https?|ftp|mailto|javascript|data):\\S*|\\bwww\\.\\S+|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b\\S*)`, 'gi');
export function safeText(value, max) {
    return oneLine(value, max * 2).replace(URLISH, '[link removed]').slice(0, max);
}

// A notification from a teammate is shown with OUR wording for its kind, not whatever title
// string it was stored with (a teammate can write any string there). Only the standard
// sentences our own app writes are accepted, and the name in front is cleaned.
const TITLE_ENDINGS = [
    ' assigned you a task', ' declined a task you assigned', ' suggested a task for you',
    ' commented on your task', ' mentioned you in a comment', ' sent a task for your review',
    ' approved your task', ' sent a task back to you', ' is blocked on a task',
    ' finished a task you were waiting on', ' updated a task for you'
];
const GENERIC_TITLE = {
    assigned: 'A task was assigned to you', declined: 'Someone declined a task you assigned', suggestion: 'A task was suggested to you',
    comment: 'Someone commented on your task', mention: 'You were mentioned in a comment', review: 'A task needs your attention',
    status: 'A task you follow changed status', report: 'Your weekly report is ready', info: 'Something new in your to-do list'
};
export function displayTitle(item, uid) {
    const own = item.actorId && item.actorId === uid;
    const title = oneLine(item.title, 160);
    if (own && (item.type === 'report' || item.type === 'info')) {
        return safeText(title, 120) || GENERIC_TITLE[item.type];
    }
    const ending = TITLE_ENDINGS.find((suffix) => title.endsWith(suffix));
    if (ending && title.length - ending.length <= 80) {
        return safeText(title.slice(0, title.length - ending.length), 60) + ending;
    }
    return GENERIC_TITLE[item.type] || GENERIC_TITLE.info;
}

// Firestore's REST API wraps every value in a type tag.
export function decodeValue(value) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    if ('stringValue' in value) return value.stringValue;
    if ('timestampValue' in value) return value.timestampValue;
    if ('booleanValue' in value) return value.booleanValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return Number(value.doubleValue);
    if ('nullValue' in value) return null;
    if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
    if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
    return null;
}

export function decodeFields(fields) {
    const out = {};
    Object.keys(fields || {}).forEach((key) => {
        out[key] = decodeValue(fields[key]);
    });
    return out;
}

// "projects/p/databases/(default)/documents/users/UID/notifications/ID" -> { uid, id }
export function parseNotificationPath(name) {
    const match = /\/documents\/users\/([^/]+)\/notifications\/([^/]+)$/.exec(String(name || ''));
    return match ? { uid: match[1], id: match[2] } : null;
}

// ---- the email itself -----------------------------------------------------------

function itemLink(item, appUrl) {
    const base = String(appUrl || '').replace(/\/+$/, '');
    if (item.groupId) {
        return `${base}/group/index.html?g=${encodeURIComponent(item.groupId)}`;
    }
    return `${base}/app.html`;
}

// items: [{ type, title, body, detail, groupId, groupName, createdAt }]
export function buildEmail(rawItems, { appUrl, name, uid }) {
    // Clean every item once, up front: our wording for the title, links stripped from every
    // piece of other people's text, and the long `detail` only for a report you left yourself.
    const items = rawItems.map((item) => ({
        ...item,
        title: displayTitle(item, uid),
        body: safeText(item.body, 400),
        groupName: safeText(item.groupName, 80),
        detail: item.type === 'report' && item.actorId && item.actorId === uid ? String(item.detail || '').split('\n').map((line) => safeText(line, 200)).join('\n').slice(0, 1500) : ''
    }));
    const shown = items.slice(0, MAX_ITEMS_PER_EMAIL);
    const extra = items.length - shown.length;
    const subject = items.length === 1
        ? oneLine(items[0].title, 120)
        : `${items.length} updates in your to-do list`;
    const greeting = name ? `Hi ${safeText(name, 60)},` : 'Hi,';
    const base = String(appUrl || '').replace(/\/+$/, '');

    const textLines = [greeting, '', items.length === 1 ? 'Something happened that you haven\'t seen yet:' : 'A few things happened that you haven\'t seen yet:', ''];
    const htmlItems = [];
    shown.forEach((item) => {
        const link = itemLink(item, appUrl);
        textLines.push(`* ${oneLine(item.title, 160)}`);
        if (item.body) {
            textLines.push(`  ${oneLine(item.body, 400)}`);
        }
        if (item.detail) {
            String(item.detail).split('\n').slice(0, 30).forEach((line) => textLines.push(`  ${oneLine(line, 200)}`));
        }
        if (item.groupName) {
            textLines.push(`  in ${oneLine(item.groupName, 80)}`);
        }
        textLines.push(`  ${link}`, '');

        const detailHtml = item.detail
            ? `<pre style="margin:8px 0 0;padding:10px 12px;background:#f3f0ff;border-radius:8px;font:13px/1.5 Consolas,Menlo,monospace;white-space:pre-wrap;color:#2b2150;">${escapeHtml(String(item.detail).slice(0, 1500))}</pre>`
            : '';
        htmlItems.push(`
        <tr><td style="padding:14px 0;border-bottom:1px solid #e7e2fb;">
          <div style="font-size:15px;font-weight:700;color:#1d1540;">${escapeHtml(oneLine(item.title, 160))}</div>
          ${item.body ? `<div style="margin-top:4px;font-size:14px;line-height:1.5;color:#4a4270;">${escapeHtml(oneLine(item.body, 400))}</div>` : ''}
          ${detailHtml}
          <div style="margin-top:8px;font-size:13px;">
            ${item.groupName ? `<span style="color:#7a72a3;">in ${escapeHtml(oneLine(item.groupName, 80))} &middot; </span>` : ''}<a href="${escapeHtml(link)}" style="color:#5b4bd6;font-weight:700;">Open</a>
          </div>
        </td></tr>`);
    });
    if (extra > 0) {
        textLines.push(`...and ${extra} more. Open the app to see them all: ${base}/app.html`, '');
        htmlItems.push(`<tr><td style="padding:12px 0;font-size:14px;color:#4a4270;">...and ${extra} more. <a href="${escapeHtml(base)}/app.html" style="color:#5b4bd6;font-weight:700;">Open the app</a> to see them all.</td></tr>`);
    }
    textLines.push('You only get this email for things you haven\'t looked at yet. To turn it off, open the app, then Settings, then "Email me about new notifications".');

    const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f4ff;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:24px;">
    <tr><td style="font-size:16px;color:#1d1540;padding-bottom:6px;">${escapeHtml(greeting)}</td></tr>
    <tr><td style="font-size:14px;color:#4a4270;padding-bottom:6px;">${items.length === 1 ? 'Something happened that you haven\'t seen yet:' : 'A few things happened that you haven\'t seen yet:'}</td></tr>
    ${htmlItems.join('')}
    <tr><td style="padding-top:16px;font-size:12px;line-height:1.5;color:#8a83ad;">You only get this email for things you haven't looked at yet. To turn it off, open the app, then Settings, then "Email me about new notifications".</td></tr>
  </table>
</body></html>`;

    return { subject, text: textLines.join('\n'), html };
}

// ---- Google auth + Firestore REST ---------------------------------------------------

let cachedToken = null;

export async function getAccessToken(env, fetchFn = fetch) {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
        return cachedToken.value;
    }
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const key = await importPKCS8(account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/cloud-platform' })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(account.client_email)
        .setSubject(account.client_email)
        .setAudience('https://oauth2.googleapis.com/token')
        .setIssuedAt()
        .setExpirationTime('55m')
        .sign(key);
    const response = await fetchFn('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
    });
    if (!response.ok) {
        throw new Error(`Google token exchange failed (${response.status})`);
    }
    const data = await response.json();
    cachedToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3000) * 1000 };
    return cachedToken.value;
}

const docsUrl = (env) => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function firestoreFetch(env, token, path, init, fetchFn) {
    const response = await fetchFn(`${docsUrl(env)}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init && init.headers) }
    });
    return response;
}

async function readCursor(env, token, fetchFn) {
    const response = await firestoreFetch(env, token, '/system/emailCursor', { method: 'GET' }, fetchFn);
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`Could not read the email cursor (${response.status})`);
    }
    const data = await response.json();
    return decodeFields(data.fields || {}).lastCreatedAt || null;
}

async function writeCursor(env, token, iso, fetchFn) {
    const response = await firestoreFetch(
        env, token, '/system/emailCursor?updateMask.fieldPaths=lastCreatedAt',
        { method: 'PATCH', body: JSON.stringify({ fields: { lastCreatedAt: { timestampValue: iso } } }) },
        fetchFn
    );
    if (!response.ok) {
        throw new Error(`Could not save the email cursor (${response.status})`);
    }
}

async function queryNotifications(env, token, afterIso, uptoIso, fetchFn) {
    const response = await fetchFn(`${docsUrl(env)}:runQuery`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            structuredQuery: {
                from: [{ collectionId: 'notifications', allDescendants: true }],
                where: {
                    compositeFilter: {
                        op: 'AND',
                        filters: [
                            { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN', value: { timestampValue: afterIso } } },
                            { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: uptoIso } } }
                        ]
                    }
                },
                orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }],
                limit: QUERY_LIMIT
            }
        })
    });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 400);
        throw new Error(`Notification query failed (${response.status}): ${detail}`);
    }
    const rows = await response.json();
    return rows.filter((row) => row.document).map((row) => ({
        path: parseNotificationPath(row.document.name),
        data: decodeFields(row.document.fields || {})
    })).filter((row) => row.path);
}

// The address and whether it is VERIFIED come from Firebase Auth itself, never from the profile
// document (a person could type anybody's address into a profile). Unverified addresses get
// nothing: otherwise anyone could sign up with a stranger's address and make us email them.
async function lookupAuthUser(env, token, uid, fetchFn) {
    const response = await fetchFn(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ localId: [uid] })
    });
    if (!response.ok) {
        return null;
    }
    const data = await response.json();
    const user = data && Array.isArray(data.users) ? data.users[0] : null;
    return user ? { email: user.email, emailVerified: user.emailVerified === true } : null;
}

async function readUser(env, token, uid, fetchFn) {
    const response = await firestoreFetch(env, token, `/users/${encodeURIComponent(uid)}`, { method: 'GET' }, fetchFn);
    if (!response.ok) {
        return null;
    }
    const data = await response.json();
    return decodeFields(data.fields || {});
}

// ---- sending ------------------------------------------------------------------------

export async function sendEmail(env, { to, subject, text, html }, fetchFn = fetch) {
    const response = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, html })
    });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`Resend rejected the email (${response.status}): ${detail}`);
    }
}

export function isConfigured(env) {
    return Boolean(env.EMAIL_FROM && env.RESEND_API_KEY && env.FIREBASE_SERVICE_ACCOUNT);
}

const looksLikeEmail = (value) => typeof value === 'string' && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value) && value.length <= 254;

// One pass of the job. Returns a small summary (also what the tests look at).
export async function runDigest(env, { now = Date.now(), fetchFn = fetch } = {}) {
    if (!isConfigured(env)) {
        return { skipped: 'not configured' };
    }
    const token = await getAccessToken(env, fetchFn);
    const cutoffIso = new Date(now - SETTLE_MS).toISOString();
    const storedCursor = await readCursor(env, token, fetchFn);
    if (!storedCursor) {
        // Very first run: start from now. Never email the backlog that built up before email existed.
        await writeCursor(env, token, cutoffIso, fetchFn);
        return { skipped: 'first run, starting from now' };
    }
    const cursorIso = storedCursor;
    // Compare as numbers: Firestore's timestamps have microseconds, ours have milliseconds, so
    // comparing the strings would be wrong.
    if (Date.parse(cursorIso) >= Date.parse(cutoffIso)) {
        return { skipped: 'nothing new yet' };
    }

    const rows = await queryNotifications(env, token, cursorIso, cutoffIso, fetchFn);
    const byUser = new Map();
    rows.forEach((row) => {
        if (row.data.readAt) {
            return;
        }
        if (!byUser.has(row.path.uid)) {
            byUser.set(row.path.uid, []);
        }
        byUser.get(row.path.uid).push(row.data);
    });

    let sent = 0;
    let skippedOff = 0;
    let failed = 0;
    for (const [uid, items] of byUser) {
        if (sent + failed >= MAX_EMAILS_PER_RUN) {
            break;
        }
        const user = await readUser(env, token, uid, fetchFn);
        if (!user || user.emailNotifications === false) {
            skippedOff += 1;
            continue;
        }
        const auth = await lookupAuthUser(env, token, uid, fetchFn);
        if (!auth || !auth.emailVerified || !looksLikeEmail(auth.email)) {
            skippedOff += 1;
            continue;
        }
        try {
            const email = buildEmail(items, { appUrl: env.APP_URL, name: user.displayName, uid });
            await sendEmail(env, { to: auth.email, ...email }, fetchFn);
            sent += 1;
        } catch (error) {
            failed += 1;
            console.error('Email failed for one person:', error.message);
        }
    }

    // If the query was full there may be more waiting: pick up from the last one we saw next time.
    const lastSeen = rows.length >= QUERY_LIMIT ? rows[rows.length - 1].data.createdAt : cutoffIso;
    await writeCursor(env, token, lastSeen || cutoffIso, fetchFn);
    return { checked: rows.length, people: byUser.size, sent, skippedOff, failed };
}

// ---- the test endpoint -----------------------------------------------------------------

function corsHeaders(origin, env) {
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
    return {
        'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || ''),
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        Vary: 'Origin'
    };
}

function json(body, status, origin, env) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) } });
}

async function verifyCaller(request, env) {
    const match = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
    if (!match) {
        throw new Error('missing bearer token');
    }
    const { payload } = await jwtVerify(match[1], JWKS, {
        issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
        audience: env.FIREBASE_PROJECT_ID,
        algorithms: ['RS256']
    });
    if (typeof payload.sub !== 'string' || !payload.sub) {
        throw new Error('missing sub');
    }
    return { uid: payload.sub, email: payload.email, emailVerified: payload.email_verified === true, name: payload.name };
}

// One test email per person per 10 minutes, remembered in Cloudflare's cache (it survives across
// requests, unlike a variable). Best effort, but it keeps one account from burning the shared
// daily sending allowance.
async function tooSoon(uid) {
    if (typeof caches === 'undefined') {
        return false;
    }
    const key = new Request(`https://throttle.invalid/test/${encodeURIComponent(uid)}`);
    const cache = caches.default;
    if (await cache.match(key)) {
        return true;
    }
    await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=600' } }));
    return false;
}

async function handleFetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/test') {
        return json({ error: 'not found' }, 404, origin, env);
    }
    let caller;
    try {
        caller = await verifyCaller(request, env);
    } catch (error) {
        return json({ error: 'unauthorized' }, 401, origin, env);
    }
    if (!isConfigured(env)) {
        return json({ error: 'not_configured', message: 'Email is not switched on for this app yet.' }, 503, origin, env);
    }
    if (!looksLikeEmail(caller.email)) {
        return json({ error: 'no_email', message: 'Your account has no email address to send to.' }, 400, origin, env);
    }
    if (!caller.emailVerified) {
        return json({ error: 'unverified', message: 'Your email address is not verified, so we can\'t send to it. Signing in with Google verifies it.' }, 403, origin, env);
    }
    if (await tooSoon(caller.uid)) {
        return json({ error: 'slow_down', message: 'Please wait a few minutes before sending another test.' }, 429, origin, env);
    }
    try {
        const email = buildEmail([{
            type: 'info',
            actorId: caller.uid,
            title: 'Email notifications are working',
            body: 'This is a test. When something happens that you haven\'t looked at for a few minutes, you\'ll get an email like this one.',
            groupId: '',
            groupName: ''
        }], { appUrl: env.APP_URL, name: caller.name, uid: caller.uid });
        await sendEmail(env, { to: caller.email, ...email });
        return json({ ok: true }, 200, origin, env);
    } catch (error) {
        console.error('Test email failed:', error.message);
        return json({ error: 'send_failed', message: 'The email could not be sent. Check the sender setup.' }, 502, origin, env);
    }
}

export default {
    fetch: handleFetch,
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runDigest(env).then((summary) => console.log('email run', JSON.stringify(summary))).catch((error) => console.error('email run failed:', error.message)));
    }
};
