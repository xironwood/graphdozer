import {
  factsPath, insurancePath, intakeScope, receiptLifetime, repository,
} from '../../practice-records/studio-intake.mjs';

const origin = 'https://graphdozer.com';
const approvalPath = '/studio/api/approvals';
const github = 'https://api.github.com/repos/' + repository;
const githubHeaders = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Graphdozer-Studio' };
const encoder = new TextEncoder();

function reply(status, body, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function digest(text) {
  return crypto.subtle.digest('SHA-256', encoder.encode(text));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function isOwner(request, password) {
  const received = request.headers.get('Authorization') ?? '';
  const expected = 'Basic ' + btoa('owner:' + password);
  const [left, right] = await Promise.all([digest(received), digest(expected)]);
  return new Uint8Array(left).reduce((different, byte, index) => different | (byte ^ new Uint8Array(right)[index]), 0) === 0;
}

async function approvedDraft(request, env) {
  if (request.headers.get('Origin') !== origin) return reply(403, { error: 'Stamp from Graphdozer Practice Studio.' });
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return reply(415, { error: 'Expected a JSON draft.' });

  const raw = await request.text();
  if (raw.length > 4096) return reply(413, { error: 'The draft is too large.' });
  let draft;
  try { draft = JSON.parse(raw); }
  catch { return reply(400, { error: 'Invalid draft JSON.' }); }
  const only = (value, ...keys) => value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const pricing = draft?.changes?.pricing;
  const next = pricing?.intake;
  if (!only(draft, 'version', 'changes') || !only(draft.changes, 'pricing') || !only(pricing, 'intake') ||
      typeof next !== 'number' || next < 0 || next > 500 || next % 5 !== 0) {
    return reply(422, { error: 'The hosted pilot accepts one change to the intake fee. Keep the other fields at their live values.' });
  }

  const upstream = await fetch(github + '/git/ref/heads/main', { headers: githubHeaders, redirect: 'manual', cache: 'no-store' });
  if (!upstream.ok) throw new Error('GitHub source is unavailable.');
  const base = (await upstream.json()).object.sha;
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid GitHub source version.');
  const getRecord = async (path) => {
    const response = await fetch(`https://raw.githubusercontent.com/${repository}/${base}/${path}`, { redirect: 'manual' });
    if (!response.ok) throw new Error('GitHub record is unavailable.');
    return response.text();
  };
  const [facts, insurance] = await Promise.all([getRecord(factsPath), getRecord(insurancePath)]);
  const version = hex(await digest(facts + '\0' + insurance));
  if (draft.version !== version) return reply(409, { error: 'The records changed. Reopen Studio after the current release is live.' });
  const previous = JSON.parse(facts).pricing.intake;
  if (previous === next) return reply(422, { error: 'Change the intake fee before stamping.' });

  // A retry against the same commit and values produces the same branch and PR.
  const key = hex(await digest(`${base}:${next}`));
  const id = [key.slice(0, 8), key.slice(8, 12), key.slice(12, 16), key.slice(16, 20), key.slice(20, 32)].join('-');
  const approved = Date.now();
  const payload = encoder.encode(JSON.stringify({ scope: intakeScope, id, version, previous, next, approved, expires: approved + receiptLifetime }));
  const pem = env.STUDIO_SIGNING_KEY.replace(/-----[^-]+-----|\s/g, '');
  const signer = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (character) => character.charCodeAt(0)), 'Ed25519', false, ['sign']);
  const signature = await crypto.subtle.sign('Ed25519', signer, payload);
  const dispatch = await fetch(github + '/actions/workflows/studio-intake.yml/dispatches', {
    method: 'POST',
    headers: { ...githubHeaders, Authorization: 'Bearer ' + env.STUDIO_GITHUB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { id, payload: base64url(payload), signature: base64url(signature) } }),
    redirect: 'manual',
  });
  if (!dispatch.ok) throw new Error('GitHub did not accept the approval.');
  return reply(202, { id, status: 'queued' });
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (url.origin !== origin) return reply(404, { error: 'Practice Studio is available at Graphdozer.' });
  if (!env.STUDIO_OWNER_PASSWORD || !env.STUDIO_SIGNING_KEY || !env.STUDIO_GITHUB_TOKEN) {
    return reply(503, { error: 'The hosted Studio pilot is awaiting setup.' });
  }
  if (!await isOwner(request, env.STUDIO_OWNER_PASSWORD)) {
    return reply(401, { error: 'Sign in to Graphdozer Practice Studio.' }, { 'WWW-Authenticate': 'Basic realm="Graphdozer Studio"' });
  }
  if (url.pathname === approvalPath && request.method === 'POST') {
    try { return await approvedDraft(request, env); }
    catch { return reply(502, { error: 'GitHub could not receive the approval. Your draft is still open.' }); }
  }
  if (!['/studio', '/studio/'].includes(url.pathname) || !['GET', 'HEAD'].includes(request.method)) {
    return reply(404, { error: 'Studio page not found.' });
  }
  const asset = await next();
  const response = new Response(asset.body, asset);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('X-Frame-Options', 'DENY');
  return response;
}
