// MCP over POST /mcp (streamable HTTP, plain JSON responses — no SSE needed).
//
// The client probes `server/discover` first (2026-07-28 revision); a pre-discover server
// answering `initialize` with a legacy revision also passes. Parse errors are HTTP 400 with
// JSON-RPC -32700; unknown methods are -32601; unknown tools and missing required arguments
// are -32602 (or isError:true). No-auth is HTTP 401. tools/list is a fixed constant, so two
// calls are byte-identical.

import { ForgeStore, issueToJson, pullToJson, repoToJson } from './store.ts';
import { isAuthenticated } from './rest.ts';
import { VIEWER } from './scenario.ts';

export const MCP_SERVER_NAME = 'github-core-clone-01';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** The tool list, fixed at module load so tools/list is byte-identical across calls. */
const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach (must exist).' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

interface ToolOutcome {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
}

function missingArg(name: string): ToolOutcome {
  return { ok: false, error: `missing required argument: ${name}` };
}

function asStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = asStringArg(args, 'name');
      if (repoName === undefined) return missingArg('name');
      const repo = store.createRepo(VIEWER.login, {
        name: repoName,
        description: asStringArg(args, 'description'),
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      if (repo === null) return { ok: false, error: `repository ${VIEWER.login}/${repoName} already exists` };
      return { ok: true, result: repoToJson(repo) as Record<string, unknown> };
    }
    case 'get_repo': {
      const owner = asStringArg(args, 'owner');
      const repoName = asStringArg(args, 'repo');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      return { ok: true, result: repoToJson(repo) as Record<string, unknown> };
    }
    case 'create_issue': {
      const owner = asStringArg(args, 'owner');
      const repoName = asStringArg(args, 'repo');
      const title = asStringArg(args, 'title');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      if (title === undefined) return missingArg('title');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      const labels = Array.isArray(args.labels) && args.labels.every((l) => typeof l === 'string') ? (args.labels as string[]) : undefined;
      const result = store.createIssue(repo, { title, body: asStringArg(args, 'body'), labels });
      if (!result.ok) return { ok: false, error: result.message };
      return { ok: true, result: issueToJson(result.issue) as Record<string, unknown> };
    }
    case 'list_issues': {
      const owner = asStringArg(args, 'owner');
      const repoName = asStringArg(args, 'repo');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      const state = asStringArg(args, 'state');
      const issues = store.listIssues(repo, state === 'closed' ? 'closed' : state === 'all' ? 'all' : 'open');
      return { ok: true, result: { issues: issues.map((i) => issueToJson(i)) } };
    }
    case 'create_pull_request': {
      const owner = asStringArg(args, 'owner');
      const repoName = asStringArg(args, 'repo');
      const title = asStringArg(args, 'title');
      const head = asStringArg(args, 'head');
      const base = asStringArg(args, 'base');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      if (title === undefined) return missingArg('title');
      if (head === undefined) return missingArg('head');
      if (base === undefined) return missingArg('base');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      const result = store.createPull(repo, { title, body: asStringArg(args, 'body'), head, base });
      if (!result.ok) return { ok: false, error: result.message };
      return { ok: true, result: pullToJson(result.pull) as Record<string, unknown> };
    }
    case 'merge_pull_request': {
      const owner = asStringArg(args, 'owner');
      const repoName = asStringArg(args, 'repo');
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : undefined;
      if (pullNumber === undefined) return missingArg('pull_number');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { ok: false, error: `repository ${owner}/${repoName} not found` };
      const result = store.mergePull(repo, pullNumber);
      if (!result.ok) return { ok: false, error: result.message };
      return { ok: true, result: { merged: true, sha: result.sha, number: result.pull.number, state: pullStateOf(result.pull) } };
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

function pullStateOf(pull: { merged: boolean; state: string }): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

export interface McpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

function jsonRpc(id: unknown, result: unknown): McpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), 'utf8'),
  };
}

function jsonRpcError(status: number, id: unknown, code: number, message: string, data?: unknown): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error }), 'utf8'),
  };
}

/**
 * Handle a POST to /mcp. `headers` are the lower-cased request headers, `body` the raw body.
 * Returns null when the path is not /mcp.
 */
export function handleMcp(
  store: ForgeStore,
  method: string,
  pathname: string,
  headers: Record<string, string | undefined>,
  body: Buffer,
): McpResponse | null {
  if (pathname !== '/mcp') return null;
  if (method === 'DELETE') {
    // A legacy session close: nothing is held, so there is nothing to forget.
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}', 'utf8') };
  }
  if (method !== 'POST') {
    return jsonRpcError(405, null, -32601, 'Method not found');
  }
  if (!isAuthenticated(headers)) {
    return jsonRpcError(401, null, -32001, 'Requires authentication');
  }
  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return jsonRpcError(400, null, -32700, 'Parse error');
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return jsonRpcError(400, null, -32700, 'Parse error');
  }
  const rpc = request as Record<string, unknown>;
  const id = (rpc.id ?? null) as string | number | null;
  const methodName = typeof rpc.method === 'string' ? rpc.method : '';
  const params = (typeof rpc.params === 'object' && rpc.params !== null && !Array.isArray(rpc.params) ? rpc.params : {}) as Record<string, unknown>;

  // A notification (no id) gets no JSON-RPC response body.
  const isNotification = rpc.id === undefined;

  switch (methodName) {
    case 'server/discover': {
      return jsonRpc(id, {
        resultType: 'discover',
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL.',
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'initialize': {
      const offered = typeof (params.protocolVersion as unknown) === 'string' ? (params.protocolVersion as string) : '';
      const chosen = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : MCP_SUPPORTED_VERSIONS[0] as string;
      return jsonRpc(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled': {
      if (isNotification) return { status: 202, headers: {}, body: Buffer.alloc(0) };
      return jsonRpc(id, {});
    }
    case 'ping': {
      return jsonRpc(id, {});
    }
    case 'tools/list': {
      return jsonRpc(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS_BY_NAME.get(toolName);
      if (tool === undefined) {
        return jsonRpcError(200, id, -32602, `unknown tool: ${toolName}`);
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      // Missing required arguments are a tool-level error (isError), matching the suite's
      // "missing required args: isError:true or -32602" rule.
      const outcome = callTool(store, toolName, args);
      if (!outcome.ok) {
        return jsonRpc(id, {
          content: [{ type: 'text', text: outcome.error ?? 'tool error' }],
          isError: true,
        });
      }
      const text = JSON.stringify(outcome.result ?? {});
      return jsonRpc(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.result ?? {},
      });
    }
    default: {
      return jsonRpcError(200, id, -32601, `Method not found: ${methodName}`);
    }
  }
}
