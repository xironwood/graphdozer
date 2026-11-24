import { createHash, createPrivateKey, timingSafeEqual } from 'node:crypto';
import { accessSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStudioDraft, readStudioRecords } from './apply-studio-draft.mjs';
import { openStudioApprovals } from './studio-approvals.mjs';
import { StudioDraftError } from './studio-draft.mjs';
import { isIntakeDraft, signIntakeReceipt } from './studio-receipt.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const draftLimit = 32 * 1024;
const approvalPath = '/studio/api/approvals';
const agentPath = '/studio-agent/approvals';
const buildAction = /^\/studio-agent\/approvals\/([a-f0-9-]{36})\/apply$/;
const staticPages = new Map([
  ['/', 'index.html'],
  ['/studio/', 'studio/index.html'],
  ['/contact/', 'contact/index.html'],
  ['/faq/', 'faq/index.html'],
  ['/good-faith-estimate/', 'good-faith-estimate/index.html'],
  ['/insurance/', 'insurance/index.html'],
  ['/llms.txt', 'llms.txt'],
]);
const asset = /^\/_astro\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(css|js)$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const digest = (text) => createHash('sha256').update(text).digest();
const matches = (provided, expected) => typeof provided === 'string' && timingSafeEqual(digest(provided), expected);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body === null ? undefined : JSON.stringify(body));
}

async function readDraft(req) {
  const mime = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (mime !== 'application/json') throw new HttpError(415, 'Submit the draft as JSON.');
  if (Number(req.headers['content-length']) > draftLimit) throw new HttpError(413, 'The draft is too large.');

  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > draftLimit) throw new HttpError(413, 'The draft is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The draft contains invalid JSON.');
  }
}

export function createStudioServer({
  origin, owner, ownerPassword, agentToken, approvals, signingKey,
  readRecords = readStudioRecords, buildDraft = buildStudioDraft,
}) {
  if (!owner || /[:\r\n]/.test(owner) || !ownerPassword || !agentToken || ownerPassword === agentToken) {
    throw new Error('Set distinct STUDIO_OWNER_PASSWORD and STUDIO_AGENT_TOKEN values and a valid owner name.');
  }
  const url = new URL(origin);
  const ownerAuth = digest('Basic ' + Buffer.from(`${owner}:${ownerPassword}`).toString('base64'));
  const agentAuth = digest('Bearer ' + agentToken);

  async function applyApproval(id, res) {
    const claimed = approvals.claim(id);
    if (!claimed) {
      const existing = approvals.get(id);
      if (!existing) throw new HttpError(404, 'Approval receipt not found.');
      return send(res, existing.status === 'ready' ? 200 : 409, existing);
    }

    let status = 'ready';
    let review;
    try {
      const signedReceipt = signingKey && isIntakeDraft(claimed.draft)
        ? signIntakeReceipt(signingKey, { id, ...claimed }, readRecords()) : undefined;
      review = await buildDraft(claimed.draft);
      if (signedReceipt) review = { ...review, signedReceipt };
    } catch (error) {
      status = error instanceof StudioDraftError && error.code === 'stale' ? 'stale' : 'failed';
      review = { error: error.message };
    }
    if (!approvals.finish(id, claimed.token, status, review)) {
      throw new HttpError(409, 'Another runner claimed this approval. Check its current status.');
    }
    return send(res, status === 'ready' ? 200 : status === 'stale' ? 409 : 422, { id, status, review });
  }

  return createServer(async (req, res) => {
    try {
      const requested = new URL(req.url, url);
      if (req.headers.host !== url.host || requested.origin !== url.origin) throw new HttpError(403, 'Invalid Studio host.');
      const { pathname } = requested;
      const ownerRoute = pathname === '/studio' || pathname === '/studio/' || pathname === approvalPath;
      if (ownerRoute && !matches(req.headers.authorization, ownerAuth)) {
        return send(res, 401, { error: 'Sign in to Practice Studio.' }, { 'WWW-Authenticate': 'Basic realm="Practice Studio", charset="UTF-8"' });
      }
      if (pathname === approvalPath) {
        if (req.method !== 'POST') return send(res, 405, { error: 'Use POST to save an approval.' }, { Allow: 'POST' });
        // This browser action uses ambient credentials, so require the configured exact origin.
        if (req.headers.origin !== url.origin) throw new HttpError(403, 'Submit the approval from Practice Studio.');
        const draft = await readDraft(req);
        const { created, ...receipt } = approvals.save(owner, readRecords(), draft);
        return send(res, created ? 201 : 200, receipt);
      }
      const action = buildAction.exec(pathname);
      if (pathname === agentPath || action) {
        if (!matches(req.headers.authorization, agentAuth)) {
          return send(res, 401, { error: 'Agent credentials required.' }, { 'WWW-Authenticate': 'Bearer' });
        }
        const method = action ? 'POST' : 'GET';
        if (req.method !== method) return send(res, 405, { error: `Use ${method} for this action.` }, { Allow: method });
        if (!action) return send(res, 200, { approvals: approvals.pending() });
        if (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']) {
          throw new HttpError(400, 'Apply takes the approval ID only.');
        }
        return await applyApproval(action[1], res);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Page not found.');
      if (pathname === '/studio') return send(res, 308, null, { Location: '/studio/' });
      const assetMatch = asset.exec(pathname);
      const file = staticPages.get(pathname) ?? (assetMatch ? pathname.slice(1) : null);
      if (!file) throw new HttpError(404, 'Page not found.');
      const mime = assetMatch?.[1] === 'js' ? 'text/javascript' : assetMatch ? 'text/css' : file.endsWith('.txt') ? 'text/plain' : 'text/html';
      const data = await readFile(join(root, 'dist', file));
      res.writeHead(200, {
        'Content-Type': `${mime}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (error instanceof StudioDraftError) return send(res, error.code === 'stale' ? 409 : 422, { error: error.message });
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      if (error.code === 'ENOENT') return send(res, 404, { error: 'Run npm run build to refresh the local site.' });
      console.error(error);
      return send(res, 500, { error: 'Studio could not save the approval.' });
    }
  });
}

function main() {
  if (process.argv[2] === '--help') {
    console.log(`Run npm run build, then npm run studio:serve with STUDIO_OWNER_PASSWORD and STUDIO_AGENT_TOKEN set in your environment.
Studio listens on 127.0.0.1:4321 by default. STUDIO_PORT sets the port. STUDIO_OWNER sets the sign-in name, which defaults to owner.
For signed intake approvals, set STUDIO_RECEIPT_PRIVATE_KEY_FILE to an Ed25519 private key PEM outside the checkout.

Agent endpoints use the agent token as a Bearer credential:
  GET  /studio-agent/approvals
  POST /studio-agent/approvals/<receipt-id>/apply`);
    return;
  }
  const {
    STUDIO_OWNER = 'owner',
    STUDIO_OWNER_PASSWORD,
    STUDIO_AGENT_TOKEN,
    STUDIO_RECEIPT_PRIVATE_KEY_FILE,
    STUDIO_PORT = '4321',
  } = process.env;
  try {
    const port = Number(STUDIO_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('STUDIO_PORT must be between 1024 and 65535.');
    const signingKey = STUDIO_RECEIPT_PRIVATE_KEY_FILE && createPrivateKey(readFileSync(STUDIO_RECEIPT_PRIVATE_KEY_FILE));
    if (signingKey && signingKey.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 signing key is required.');
    accessSync(join(root, 'dist/studio/index.html'));
    const storage = join(root, '.astro', 'studio-approvals');
    mkdirSync(storage, { recursive: true, mode: 0o700 });
    const file = join(storage, 'approvals.sqlite');
    closeSync(openSync(file, 'a', 0o600));
    const approvals = openStudioApprovals(file);
    const origin = `http://127.0.0.1:${port}`;
    const server = createStudioServer({
      origin, approvals, owner: STUDIO_OWNER, ownerPassword: STUDIO_OWNER_PASSWORD, agentToken: STUDIO_AGENT_TOKEN, signingKey,
    });
    server.listen(port, '127.0.0.1', () => console.log(`Practice Studio is available at ${origin}/studio/.`));
  } catch (error) {
    console.error(error.code === 'ENOENT' ? 'Run npm run build before serving Studio.' : error.message);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
