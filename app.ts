// The forge's HTTP front door: one node:http server that routes each request to the
// surface that owns it — git smart HTTP, REST v3, GraphQL v4, MCP — and answers a JSON
// 404 for anything else. Bodies are read whole before dispatch (the largest body a
// client sends is a packfile, bounded by the trial), and every reply carries a
// non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { scenarioIdentity } from './scenario.ts';
import { bearerToken, handleRest, type HttpContext } from './rest.ts';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    out[name] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { ...headers, 'content-length': String(payload.length) });
  res.end(payload);
}

/** Build the forge server. It binds nothing until the caller listens on a port. */
export function createForgeServer(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const identity = scenarioIdentity();
  const forge = new Forge(identity.viewer.login, identity.viewer.name, identity.viewer.email, token);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname, query } = pathOf(req);
      const method = req.method ?? 'GET';
      const headers = headersOf(req);
      const requestId = forge.nextRequestId();
      try {
        const body = await readBody(req);
        const ctx: HttpContext = { method, pathname, query, headers, body };
        const presented = bearerToken(ctx);
        const authorized = token === '' ? presented !== null : presented === token;

        // The env's boot probe: 200 {"ok":true}, no token needed.
        if (method === 'GET' && pathname === '/healthz') {
          send(res, 200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId }, '{"ok":true}\n');
          return;
        }

        const git = handleGit(forge, ctx);
        if (git !== null) {
          const bodyText = git.body;
          const payload = Buffer.from(bodyText, 'latin1');
          send(res, git.status, { ...git.headers, 'x-github-request-id': requestId }, payload);
          return;
        }

        if (pathname === '/api/graphql' && method === 'POST') {
          const answered = handleGraphql(forge, ctx, authorized);
          if (answered !== null) {
            send(res, answered.status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId }, answered.body);
            return;
          }
        }

        if (pathname === '/mcp') {
          const answered = handleMcp(forge, ctx, authorized);
          if (answered !== null) {
            send(res, answered.status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId, ...(answered.headers ?? {}) }, answered.body);
            return;
          }
        }

        if (pathname.startsWith('/api/v3')) {
          const answered = await handleRest(forge, ctx, authorized);
          if (answered !== null) {
            send(res, answered.status, { ...answered.headers, 'x-github-request-id': requestId }, answered.body);
            return;
          }
        }

        send(res, 404, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId }, '{"message":"Not Found"}\n');
      } catch (err) {
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : 'internal error';
          send(res, 500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId }, `${JSON.stringify({ message })}\n`);
        }
      }
    })();
  });
}
