// The forge's HTTP server: one router over /healthz, git smart HTTP, REST v3, GraphQL and MCP.
// Every route that is not /healthz answers JSON (or the git binary content types); unknown
// paths are a JSON 404. Request bodies are read whole (the suite's bodies are small).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ForgeStore } from './lib/store.ts';
import { handleGit } from './lib/git-http.ts';
import { handleRest } from './lib/rest.ts';
import { executeGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { isAuthenticated } from './lib/rest.ts';

export const store = new ForgeStore();

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
  // An explicit Content-Length avoids chunked transfer encoding and lets the client reuse the
  // connection efficiently (the benchmark workloads are sequential keep-alive requests).
  response.writeHead(status, { 'content-length': String(body.length), ...headers });
  response.end(body);
}

function json404(message: string): { status: number; headers: Record<string, string>; body: Buffer } {
  return {
    status: 404,
    headers: { 'content-type': 'application/json', 'x-github-request-id': 'req-000000' },
    body: Buffer.from(JSON.stringify({ message }), 'utf8'),
  };
}

/** The GraphQL HTTP endpoint: one operation or a batch array, always JSON. */
function handleGraphQL(
  headers: Record<string, string | undefined>,
  body: Buffer,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const outHeaders: Record<string, string> = { 'content-type': 'application/json' };
  if (!isAuthenticated(headers)) {
    return { status: 401, headers: outHeaders, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Requires authentication' }] }), 'utf8') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, headers: outHeaders, body: Buffer.from(JSON.stringify({ errors: [{ message: 'malformed JSON body' }] }), 'utf8') };
  }
  const runOne = (operation: unknown): Record<string, unknown> => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      return { data: null, errors: [{ message: 'an operation must be an object with a query string' }] };
    }
    const op = operation as Record<string, unknown>;
    const query = typeof op.query === 'string' ? op.query : '';
    const variables = (typeof op.variables === 'object' && op.variables !== null && !Array.isArray(op.variables) ? op.variables : {}) as Record<string, unknown>;
    const operationName = typeof op.operationName === 'string' ? op.operationName : undefined;
    if (query === '') return { data: null, errors: [{ message: 'query is required' }] };
    return executeGraphQL(store, query, variables, operationName) as unknown as Record<string, unknown>;
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(runOne);
    return { status: 200, headers: outHeaders, body: Buffer.from(JSON.stringify(results), 'utf8') };
  }
  return { status: 200, headers: outHeaders, body: Buffer.from(JSON.stringify(runOne(parsed)), 'utf8') };
}

export function createApp(): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const pathname = decodeURIComponent(url.pathname);
        const method = request.method ?? 'GET';
        // Normalize the few headers the handlers read (Node lower-cases names; a value may be
        // an array when a client repeats a header — take the first).
        const rawHeaders = request.headers;
        const headerValue = (name: string): string | undefined => {
          const value = rawHeaders[name];
          if (value === undefined) return undefined;
          return Array.isArray(value) ? value[0] : value;
        };
        const headers: Record<string, string | undefined> = {
          authorization: headerValue('authorization'),
          'git-protocol': headerValue('git-protocol'),
          host: headerValue('host'),
          'content-type': headerValue('content-type'),
          accept: headerValue('accept'),
          'mcp-protocol-version': headerValue('mcp-protocol-version'),
          'mcp-session-id': headerValue('mcp-session-id'),
        };
        const body = await readBody(request);
        const baseUrl = `http://${headers.host ?? '127.0.0.1'}`;

        // GET /healthz — no auth.
        if (pathname === '/healthz' && method === 'GET') {
          send(response, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ ok: true }), 'utf8'));
          return;
        }

        // Git smart HTTP.
        const git = handleGit(store, method, pathname, url.searchParams, headers, body);
        if (git !== null) {
          send(response, git.status, { 'content-type': git.contentType }, git.body);
          return;
        }

        // REST v3.
        const rest = handleRest({ store, baseUrl }, method, pathname, url.searchParams, headers, body);
        if (rest !== null) {
          send(response, rest.status, rest.headers, rest.body);
          return;
        }

        // GraphQL.
        if (pathname === '/api/graphql' && method === 'POST') {
          const result = handleGraphQL(headers, body);
          send(response, result.status, result.headers, result.body);
          return;
        }

        // MCP.
        const mcp = handleMcp(store, method, pathname, headers, body);
        if (mcp !== null) {
          send(response, mcp.status, mcp.headers, mcp.body);
          return;
        }

        const notFound = json404('Not Found');
        send(response, notFound.status, notFound.headers, notFound.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(response, 500, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ message }), 'utf8'));
      }
    })();
  });
}
