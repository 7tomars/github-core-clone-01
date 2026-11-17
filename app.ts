// app.ts — the HTTP server: routing and plumbing for the forge's four surfaces
// (REST v3, GraphQL v4, MCP, git smart HTTP) over one shared store.
//
// Cross-cutting rules the suite checks: every REST reply is application/json and
// carries a non-empty X-GitHub-Request-Id; errors are JSON {message} bodies; a
// missing or wrong bearer token is a 401 (except /healthz, which is open); an
// unknown route is a JSON 404; a malformed JSON body is a 400 (a JSON-RPC -32700
// on /mcp). Nothing here ever answers HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './core.ts';
import { advertise, fetchV0, fetchV2, lsRefs as lsRefsDispatch, parseFetchArgs, parseLsRefsArgs, parseV0Fetch, parseV2Request, receivePack } from './git.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 256 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${(requestCounter * 2654435761 % 0xffffff).toString(16)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(bytes: Buffer): { value: unknown; malformed: boolean } {
  if (bytes.length === 0) return { value: {}, malformed: false };
  try {
    return { value: JSON.parse(bytes.toString('utf8')), malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

export function createApp(store = new Store()): Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    void handle(store, expectedToken, req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // the socket is gone; nothing to answer on
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}

function authorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expectedToken}`;
}

async function handle(store: Store, expectedToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });

  // The env's boot probe: open, no token.
  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    if (!authorized(req, expectedToken)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    await handleGit(store, req, res, segments, url);
    return;
  }

  // REST v3
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req, expectedToken)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const bytes = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const { value, malformed } = parseJsonBody(bytes);
    const restSegments = segments.slice(2);
    const host = req.headers.host ?? 'forge.local';
    const request: RestRequest = {
      method,
      segments: restSegments,
      query: url.searchParams,
      body: value,
      bodyMalformed: malformed,
      baseUrl: `http://${host}`,
    };
    const reply = handleRest(store, request);
    if (reply.rawText !== undefined) {
      res.writeHead(reply.status, { 'x-github-request-id': nextRequestId() });
      res.end(reply.rawText);
      return;
    }
    sendJson(res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  // GraphQL v4
  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (!authorized(req, expectedToken)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const bytes = await readBody(req);
    const { value, malformed } = parseJsonBody(bytes);
    if (malformed) {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const reply = handleGraphQL(store, value);
    sendJson(res, reply.status, reply.body);
    return;
  }

  // MCP
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (!authorized(req, expectedToken)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const bytes = await readBody(req);
    const { value, malformed } = parseJsonBody(bytes);
    if (malformed) {
      res.writeHead(400, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const reply = handleMcp(store, value);
    if (reply.empty) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  const owner = segments[0]!;
  const repoName = segments[1]!.slice(0, -'.git'.length);
  const action = segments.slice(2).join('/');
  const repo = store.repos.get(repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (store.viewerLogin === null) store.learnViewer(owner);
  if (owner !== store.viewerLogin) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (action === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 403, { message: 'Unsupported service' });
      return;
    }
    const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const reply = advertise(store, repo, service, version2);
    sendRaw(res, reply.status, reply.contentType, reply.body);
    return;
  }

  if (action === 'git-upload-pack' && method === 'POST') {
    const bytes = await readBody(req);
    const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    try {
      if (version2) {
        const { command, args } = parseV2Request(bytes);
        if (command === 'ls-refs') {
          sendRaw(res, 200, 'application/x-git-upload-pack-result', lsRefsDispatch(store, repo, parseLsRefsArgs(args)));
          return;
        }
        if (command === 'fetch') {
          const reply = fetchV2(store, repo, parseFetchArgs(args));
          sendRaw(res, reply.status, reply.contentType, reply.body);
          return;
        }
        sendJson(res, 403, { message: `Unknown command ${command}` });
        return;
      }
      const reply = fetchV0(store, repo, parseV0Fetch(bytes));
      sendRaw(res, reply.status, reply.contentType, reply.body);
      return;
    } catch {
      sendJson(res, 403, { message: 'Malformed git request' });
      return;
    }
  }

  if (action === 'git-receive-pack' && method === 'POST') {
    const bytes = await readBody(req);
    const outcome = receivePack(store, repo, bytes);
    sendRaw(res, outcome.status, 'application/x-git-receive-pack-result', outcome.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
