// app.ts — routing and plumbing for the forge's four surfaces (REST v3,
// GraphQL v4, MCP, git smart HTTP) over one shared store, served by a
// hand-rolled HTTP/1.1 server on node:net. The stock node:http server spends
// most of a small request's life on machinery this forge does not need
// (header objects, stream plumbing); here a request is one buffer in, one
// buffer out, parsed with indexOf scans and answered in a single write.
//
// Cross-cutting rules the suite checks: every REST reply is application/json
// and carries a non-empty X-GitHub-Request-Id; errors are JSON {message}
// bodies; a missing or wrong bearer token is a 401 (except /healthz, which is
// open); an unknown route is a JSON 404; a malformed JSON body is a 400 (a
// JSON-RPC -32700 on /mcp). Nothing here ever answers HTML.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { Store } from './core.ts';
import { advertise, fetchV0, fetchV2, lsRefs as lsRefsDispatch, parseFetchArgs, parseLsRefsArgs, parseV0Fetch, parseV2Request, receivePack } from './git.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 256 * 1024 * 1024;
const MAX_HEAD = 64 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${(requestCounter * 2654435761 % 0xffffff).toString(16)}`;
}

// ---------------------------------------------------------------------------
// transport-neutral request/response

interface RawRequest {
  method: string;
  target: string;
  headers: Map<string, string>;
  body: Buffer;
}

interface RawResponse {
  status: number;
  headers: [string, string][];
  body: Buffer;
}

function jsonResponse(status: number, body: unknown, extra: [string, string][] = []): RawResponse {
  const text = body === null ? '' : JSON.stringify(body);
  return {
    status,
    headers: [['content-type', JSON_TYPE], ['x-github-request-id', nextRequestId()], ...extra],
    body: Buffer.from(text, 'utf8'),
  };
}

function rawResponse(status: number, contentType: string, body: Buffer): RawResponse {
  return { status, headers: [['content-type', contentType]], body };
}

// ---------------------------------------------------------------------------
// dispatch (the routing the old http server ran; semantics unchanged)

function parseJsonBody(bytes: Buffer): { value: unknown; malformed: boolean } {
  if (bytes.length === 0) return { value: {}, malformed: false };
  try {
    return { value: JSON.parse(bytes.toString('utf8')), malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

function authorized(req: RawRequest, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  return (req.headers.get('authorization') ?? '') === `Bearer ${expectedToken}`;
}

async function dispatch(store: Store, expectedToken: string, req: RawRequest): Promise<RawResponse> {
  const method = req.method;
  const url = new URL(req.target, 'http://forge.local');
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });

  // The env's boot probe: open, no token.
  if (url.pathname === '/healthz') return jsonResponse(200, { ok: true });

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    if (!authorized(req, expectedToken)) return jsonResponse(401, { message: 'Bad credentials' });
    return handleGit(store, req, segments, url);
  }

  // REST v3
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req, expectedToken)) return jsonResponse(401, { message: 'Bad credentials' });
    const { value, malformed } = parseJsonBody(req.body);
    const host = req.headers.get('host') ?? 'forge.local';
    const request: RestRequest = {
      method,
      segments: segments.slice(2),
      query: url.searchParams,
      body: value,
      bodyMalformed: malformed,
      baseUrl: `http://${host}`,
    };
    const reply = handleRest(store, request);
    if (reply.rawText !== undefined) {
      const extra: [string, string][] = [['x-github-request-id', nextRequestId()]];
      if (reply.contentType !== undefined) extra.unshift(['content-type', reply.contentType]);
      return { status: reply.status, headers: extra, body: Buffer.from(reply.rawText, 'utf8') };
    }
    const extra: [string, string][] = Object.entries(reply.headers ?? {}).map(([k, v]) => [k, v] as [string, string]);
    return jsonResponse(reply.status, reply.body, extra);
  }

  // GraphQL v4
  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (!authorized(req, expectedToken)) return jsonResponse(401, { message: 'Bad credentials' });
    if (method !== 'POST') return jsonResponse(405, { message: 'Method Not Allowed' });
    const { value, malformed } = parseJsonBody(req.body);
    if (malformed) return jsonResponse(400, { errors: [{ message: 'Problems parsing JSON' }] });
    const reply = handleGraphQL(store, value);
    return jsonResponse(reply.status, reply.body);
  }

  // MCP
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (!authorized(req, expectedToken)) return jsonResponse(401, { message: 'Bad credentials' });
    if (method !== 'POST') return jsonResponse(405, { message: 'Method Not Allowed' });
    const { value, malformed } = parseJsonBody(req.body);
    if (malformed) {
      return {
        status: 400,
        headers: [['content-type', JSON_TYPE]],
        body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'),
      };
    }
    const reply = handleMcp(store, value);
    if (reply.empty) return { status: 202, headers: [], body: Buffer.alloc(0) };
    return jsonResponse(reply.status, reply.body);
  }

  return jsonResponse(404, { message: 'Not Found' });
}

function handleGit(store: Store, req: RawRequest, segments: string[], url: URL): RawResponse {
  const method = req.method;
  const owner = segments[0]!;
  const repoName = segments[1]!.slice(0, -'.git'.length);
  const action = segments.slice(2).join('/');
  const repo = store.repos.get(repoName);
  if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
  if (store.viewerLogin === null) store.learnViewer(owner);
  if (owner !== store.viewerLogin) return jsonResponse(404, { message: 'Not Found' });

  if (action === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return jsonResponse(403, { message: 'Unsupported service' });
    }
    const version2 = (req.headers.get('git-protocol') ?? '') === 'version=2';
    const reply = advertise(store, repo, service, version2);
    return rawResponse(reply.status, reply.contentType, reply.body);
  }

  if (action === 'git-upload-pack' && method === 'POST') {
    const version2 = (req.headers.get('git-protocol') ?? '') === 'version=2';
    try {
      if (version2) {
        const { command, args } = parseV2Request(req.body);
        if (command === 'ls-refs') {
          return rawResponse(200, 'application/x-git-upload-pack-result', lsRefsDispatch(store, repo, parseLsRefsArgs(args)));
        }
        if (command === 'fetch') {
          const reply = fetchV2(store, repo, parseFetchArgs(args));
          return rawResponse(reply.status, reply.contentType, reply.body);
        }
        return jsonResponse(403, { message: `Unknown command ${command}` });
      }
      const reply = fetchV0(store, repo, parseV0Fetch(req.body));
      return rawResponse(reply.status, reply.contentType, reply.body);
    } catch {
      return jsonResponse(403, { message: 'Malformed git request' });
    }
  }

  if (action === 'git-receive-pack' && method === 'POST') {
    const outcome = receivePack(store, repo, req.body);
    return rawResponse(outcome.status, 'application/x-git-receive-pack-result', outcome.body);
  }

  return jsonResponse(404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// the raw HTTP/1.1 server

/** The small slice of the http.Server shape main.ts relies on. */
export interface ForgeServer {
  listen(port: number, callback: () => void): void;
  close(callback?: () => void): void;
  address(): { port: number } | null;
  once(event: 'error', listener: (error: Error) => void): void;
}

export function createApp(store = new Store()): ForgeServer {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const sockets = new Set<Socket>();
  let boundPort: number | null = null;

  const server: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(65_000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    void serveConnection(store, expectedToken, socket);
  });

  const adapter: ForgeServer = {
    listen(port, callback) {
      server.listen(port, () => {
        const address = server.address();
        boundPort = address !== null && typeof address === 'object' ? address.port : null;
        callback();
      });
    },
    close(callback) {
      for (const socket of sockets) socket.destroy();
      server.close(() => callback?.());
    },
    address() {
      return boundPort === null ? null : { port: boundPort };
    },
    once(event, listener) {
      server.once(event, listener);
    },
  };
  return adapter;
}

const HEAD_END = Buffer.from('\r\n\r\n');

/** One connection: parse a request, dispatch it, write the reply, repeat. */
async function serveConnection(store: Store, expectedToken: string, socket: Socket): Promise<void> {
  let buffer = Buffer.alloc(0);
  let waiter: (() => void) | null = null;
  let closed = false;

  socket.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    if (waiter !== null) {
      const wake = waiter;
      waiter = null;
      wake();
    }
  });
  socket.on('close', () => {
    closed = true;
    if (waiter !== null) {
      const wake = waiter;
      waiter = null;
      wake();
    }
  });

  const waitForData = (): Promise<void> =>
    new Promise((resolve) => {
      waiter = resolve;
    });

  /** Pull exactly `count` bytes off the front of the buffer, waiting as needed. */
  const take = async (count: number): Promise<Buffer | null> => {
    while (buffer.length < count) {
      if (closed) return null;
      await waitForData();
    }
    const out = buffer.subarray(0, count);
    buffer = buffer.subarray(count);
    return out;
  };

  /** Read until the header terminator; returns the head without it. */
  const takeHead = async (): Promise<Buffer | null> => {
    for (;;) {
      const end = buffer.indexOf(HEAD_END);
      if (end !== -1) {
        const head = buffer.subarray(0, end);
        buffer = buffer.subarray(end + HEAD_END.length);
        return head;
      }
      if (buffer.length > MAX_HEAD || closed) return null;
      await waitForData();
    }
  };

  try {
    for (;;) {
      const head = await takeHead();
      if (head === null) return;
      const parsed = parseHead(head);
      if (parsed === null) {
        await writeResponse(socket, jsonResponse(400, { message: 'Bad Request' }), true);
        return;
      }
      const { method, target, headers } = parsed;

      if ((headers.get('expect') ?? '').toLowerCase() === '100-continue') {
        socket.write('HTTP/1.1 100 Continue\r\n\r\n');
      }

      // Body framing: chunked, else Content-Length, else empty.
      let body: Buffer;
      const transferEncoding = (headers.get('transfer-encoding') ?? '').toLowerCase();
      const contentLength = Number.parseInt(headers.get('content-length') ?? '', 10);
      if (transferEncoding.includes('chunked')) {
        const decoded = await readChunked(take);
        if (decoded === null) return;
        body = decoded;
      } else if (Number.isFinite(contentLength) && contentLength > 0) {
        if (contentLength > MAX_BODY) {
          await writeResponse(socket, jsonResponse(413, { message: 'Content Too Large' }), true);
          return;
        }
        const taken = await take(contentLength);
        if (taken === null) return;
        body = taken;
      } else {
        body = Buffer.alloc(0);
      }

      let response: RawResponse;
      try {
        response = await dispatch(store, expectedToken, { method, target, headers, body });
      } catch {
        response = jsonResponse(500, { message: 'Internal Server Error' });
      }
      const closeAfter = (headers.get('connection') ?? '').toLowerCase() === 'close';
      const flushed = await writeResponse(socket, response, closeAfter);
      if (!flushed || closeAfter) return;
    }
  } catch {
    socket.destroy();
  }
}

function parseHead(head: Buffer): { method: string; target: string; headers: Map<string, string> } | null {
  const text = head.toString('latin1');
  const lineEnd = text.indexOf('\r\n');
  const requestLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
  const parts = requestLine.split(' ');
  if (parts.length < 2 || parts[0] === '' || parts[1] === '') return null;
  const headers = new Map<string, string>();
  if (lineEnd !== -1) {
    for (const line of text.slice(lineEnd + 2).split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      const existing = headers.get(name);
      headers.set(name, existing === undefined ? value : `${existing}, ${value}`);
    }
  }
  return { method: parts[0]!, target: parts[1]!, headers };
}

/** Decode a chunked body using the connection's take pull. */
async function readChunked(
  take: (count: number) => Promise<Buffer | null>,
): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    // A chunk-size line ends at the first CRLF; reuse takeHead's scan by
    // reading through a small line reader built on take.
    const line = await readLine(take);
    if (line === null) return null;
    const size = Number.parseInt(line.split(';')[0]!.trim(), 16);
    if (!Number.isFinite(size) || size < 0) return null;
    if (size === 0) {
      // Trailer part: lines until an empty line.
      for (;;) {
        const trailer = await readLine(take);
        if (trailer === null) return null;
        if (trailer === '') break;
      }
      return Buffer.concat(parts);
    }
    total += size;
    if (total > MAX_BODY) return null;
    const chunk = await take(size);
    if (chunk === null) return null;
    parts.push(chunk);
    const crlf = await take(2);
    if (crlf === null) return null;
  }
}

/** Read one CRLF-terminated line via single-byte pulls (chunk headers only). */
async function readLine(take: (count: number) => Promise<Buffer | null>): Promise<string | null> {
  const bytes: number[] = [];
  for (;;) {
    const byte = await take(1);
    if (byte === null) return null;
    const value = byte[0]!;
    if (value === 0x0a) {
      if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes.pop();
      return Buffer.from(bytes).toString('latin1');
    }
    bytes.push(value);
    if (bytes.length > 8192) return null;
  }
}

function writeResponse(socket: Socket, response: RawResponse, closeAfter: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const reason = REASONS[response.status] ?? '';
    const lines = [`HTTP/1.1 ${response.status} ${reason}`];
    for (const [name, value] of response.headers) lines.push(`${name}: ${value}`);
    lines.push(`content-length: ${response.body.length}`);
    lines.push(`connection: ${closeAfter ? 'close' : 'keep-alive'}`);
    const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
    const payload = response.body.length === 0 ? head : Buffer.concat([head, response.body]);
    if (socket.write(payload)) {
      resolve(!socket.destroyed);
      return;
    }
    socket.once('drain', () => resolve(!socket.destroyed));
    socket.once('error', () => resolve(false));
  });
}
