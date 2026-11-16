// REST v3 API under /api/v3. Every reply is application/json and carries a non-empty
// X-GitHub-Request-Id. Auth: Bearer $MAKEFUN_SHOP_TOKEN (read from the process environment
// when set; when unset, any non-empty Bearer token is accepted so local runs work). A request
// with no token, or a token that does not match the environment token, is 401. A repository
// under another owner is 404, never 403. Malformed JSON bodies are 400. 401/404/422 bodies
// carry a string `message`.

import { ForgeStore, iso, issueToJson, pullToJson, repoToJson, type Repo } from './store.ts';
import { parseCommit } from './gitobj.ts';
import { VIEWER } from './scenario.ts';

export interface RestResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(6, '0')}`;
}

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': nextRequestId(),
      ...extraHeaders,
    },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function noContent(extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status: 204,
    headers: { 'x-github-request-id': nextRequestId(), ...extraHeaders },
    body: Buffer.alloc(0),
  };
}

function error(status: 400 | 401 | 404 | 405 | 409 | 422, message: string): RestResponse {
  return json(status, { message });
}

/** True when the Authorization header names the viewer. */
export function isAuthenticated(headers: Record<string, string | undefined>): boolean {
  const auth = headers.authorization ?? headers.Authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return token === expected;
  return true;
}

/** Parse a JSON request body; returns null (and the caller sends 400) on malformed JSON. */
function parseJsonBody(body: Buffer): unknown | null {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((v) => typeof v !== 'string')) return undefined;
  return value as string[];
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; hasNext: boolean; total: number } {
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  return { pageItems, hasNext: start + perPage < items.length, total: items.length };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean, total: number): string | null {
  if (!hasNext && page <= 1) return null;
  const links: string[] = [];
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${baseUrl}${path}?${q.toString()}`;
  };
  if (hasNext) links.push(`<${build(page + 1)}>; rel="next"`);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  links.push(`<${build(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${build(1)}>; rel="first"`);
  return links.join(', ');
}

/** Resolve a repo from the path; returns the repo or the error response to send. */
function resolveRepo(store: ForgeStore, owner: string, name: string): Repo | RestResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return error(404, `repository ${owner}/${name} not found`);
  return repo;
}

// -------------------------------------------------------------------------------------------
// router entry point
// -------------------------------------------------------------------------------------------

export interface RestContext {
  readonly store: ForgeStore;
  /** The entry's own base URL (from the Host header), used for absolute pagination links. */
  readonly baseUrl: string;
}

/**
 * Handle a REST request under /api/v3. Returns null when the path is not a REST route (the
 * caller falls through). `pathname` is the decoded URL path.
 */
export function handleRest(
  ctx: RestContext,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): RestResponse | null {
  if (!pathname.startsWith('/api/v3')) return null;
  const store = ctx.store;
  const path = pathname.slice('/api/v3'.length) || '/';

  // The API root and meta need no repository, but still need auth (except /healthz, which is
  // outside /api/v3 and handled by app.ts).
  if (!isAuthenticated(headers)) return error(401, 'Requires authentication');

  const parsedBody = method === 'GET' || method === 'DELETE' || method === 'HEAD'
    ? {}
    : parseJsonBody(body);
  if (parsedBody === null) return error(400, 'malformed JSON body');
  const input = asObject(parsedBody) ?? {};

  // GET /api/v3/ — the API root.
  if (path === '/' && method === 'GET') {
    return json(200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (path === '/meta' && method === 'GET') {
    return json(200, { installed_version: 'github-core-clone-01 1.0.0' });
  }

  // GET /api/v3/user
  if (path === '/user' && method === 'GET') {
    return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
  }

  // POST /api/v3/user/repos — create a repository for the viewer.
  if (path === '/user/repos' && method === 'POST') {
    const name = asString(input.name);
    if (name === undefined || name === '') return error(422, 'name is required');
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return error(422, 'invalid repository name');
    const repo = store.createRepo(VIEWER.login, {
      name,
      description: asString(input.description),
      private: asBoolean(input.private),
    });
    if (repo === null) return error(422, `repository ${VIEWER.login}/${name} already exists`);
    return json(201, repoToJson(repo));
  }

  // GET /api/v3/user/repos — the viewer's repositories, paginated.
  if (path === '/user/repos' && method === 'GET') {
    const { page, perPage } = parsePage(query);
    const all = store.listUserRepos(VIEWER.login);
    const { pageItems, hasNext, total } = paginate(all, page, perPage);
    const extra: Record<string, string> = {};
    const link = linkHeader(ctx.baseUrl, pathname, query, page, perPage, hasNext, total);
    if (link !== null) extra.link = link;
    return json(200, pageItems.map(repoToJson), extra);
  }

  // Routes under /api/v3/repos/{owner}/{repo}(/...)
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (repoMatch === null) return error(404, 'Not Found');
  const [, owner, repoName, rest] = repoMatch as [string, string, string, string | undefined];
  const resolved = resolveRepo(store, owner, repoName);
  if ('status' in resolved) return resolved;
  const repo = resolved as Repo;
  const sub = rest ?? '';

  // GET /repos/{o}/{r}
  if (sub === '' && method === 'GET') return json(200, repoToJson(repo));

  // PATCH /repos/{o}/{r}
  if (sub === '' && method === 'PATCH') {
    const description = asString(input.description);
    if (description !== undefined) repo.description = description;
    store.touch(repo);
    return json(200, repoToJson(repo));
  }

  // DELETE /repos/{o}/{r}
  if (sub === '' && method === 'DELETE') {
    store.deleteRepo(owner, repoName);
    return noContent();
  }

  // POST /repos/{o}/{r}/git/refs — create a branch.
  if (sub === 'git/refs' && method === 'POST') {
    const ref = asString(input.ref);
    const sha = asString(input.sha);
    if (ref === undefined || sha === undefined) return error(422, 'ref and sha are required');
    if (!ref.startsWith('refs/')) return error(422, 'ref must start with refs/');
    if (!/^[0-9a-f]{40}$/.test(sha)) return error(422, 'sha must be a 40-hex object id');
    if (store.getObject(sha) === undefined) return error(422, 'sha does not exist');
    if (repo.refs.has(ref)) return error(422, `ref ${ref} already exists`);
    repo.refs.set(ref, sha);
    store.touch(repo);
    return json(201, { ref, object: { sha } });
  }

  // GET /repos/{o}/{r}/git/refs/{ref} — read one ref (used by fixtures rarely; support it).
  if (sub.startsWith('git/refs/') && method === 'GET') {
    const ref = sub.slice('git/refs/'.length);
    const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    const sha = repo.refs.get(fullRef);
    if (sha === undefined) return error(404, `ref ${fullRef} not found`);
    return json(200, { ref: fullRef, object: { sha } });
  }

  // GET /repos/{o}/{r}/branches
  if (sub === 'branches' && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }));
    return json(200, branches);
  }

  // GET /repos/{o}/{r}/commits?sha=<branch>
  if (sub === 'commits' && method === 'GET') {
    const branch = query.get('sha') ?? undefined;
    const commits = store.listCommits(repo, branch).map((c) => ({
      sha: c.sha,
      commit: { message: c.message },
    }));
    return json(200, commits);
  }

  // Contents: PUT / GET / DELETE /repos/{o}/{r}/contents/{path...}
  if (sub.startsWith('contents/')) {
    const filePath = decodeURIComponent(sub.slice('contents/'.length));
    if (method === 'PUT') {
      const message = asString(input.message) ?? '';
      const contentB64 = asString(input.content);
      if (contentB64 === undefined) return error(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return error(422, 'content is not valid base64');
      }
      const branch = asString(input.branch);
      const sha = asString(input.sha);
      const result = store.putContent(repo, filePath, content, message, branch, sha);
      if (!result.ok) return error(result.status, result.status === 409 ? 'sha does not match the current file' : 'file not found');
      return json(result.result.status, {
        content: { name: filePath.split('/').pop() ?? '', path: filePath, sha: result.result.contentSha, size: result.result.size, encoding: 'base64', type: 'file' },
        commit: { sha: result.result.commitSha },
      });
    }
    if (method === 'GET') {
      const ref = query.get('ref') ?? undefined;
      const tip = store.headOid(repo, ref);
      if (tip === undefined) return error(404, 'repository is empty');
      const tipObject = store.getObject(tip);
      if (tipObject === undefined || tipObject.type !== 'commit') return error(404, 'repository is empty');
      const tree = parseCommit(tipObject.data).tree;
      const file = store.readFileAt(tree, filePath);
      if (file !== undefined) {
        return json(200, {
          type: 'file',
          name: filePath.split('/').pop() ?? '',
          path: filePath,
          sha: file.oid,
          size: file.data.length,
          encoding: 'base64',
          content: file.data.toString('base64'),
        });
      }
      const dir = store.readDirAt(tree, filePath);
      if (dir !== undefined) return json(200, dir);
      return error(404, `path ${filePath} not found`);
    }
    if (method === 'DELETE') {
      const message = asString(input.message) ?? '';
      const branch = asString(input.branch);
      const sha = asString(input.sha);
      const result = store.deleteContent(repo, filePath, message, branch, sha);
      if (!result.ok) return error(result.status, result.status === 409 ? 'sha does not match the current file' : 'file not found');
      return json(200, { commit: { sha: result.commitSha } });
    }
    return error(405, 'Method Not Allowed');
  }

  // Labels
  if (sub === 'labels' && method === 'POST') {
    const name = asString(input.name);
    if (name === undefined || name === '') return error(422, 'name is required');
    const label = store.createLabel(repo, name, asString(input.color) ?? '000000', asString(input.description) ?? '');
    return json(201, { name: label.name, color: label.color, description: label.description });
  }
  if (sub === 'labels' && method === 'GET') {
    return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
  }

  // Issues
  if (sub === 'issues' && method === 'POST') {
    const title = asString(input.title);
    if (title === undefined || title === '') return error(422, 'title is required');
    const labels = asStringArray(input.labels);
    const result = store.createIssue(repo, { title, body: asString(input.body), labels });
    if (!result.ok) return error(422, result.message);
    return json(201, issueToJson(result.issue));
  }
  if (sub === 'issues' && method === 'GET') {
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    const { page, perPage } = parsePage(query);
    let issues = store.listIssues(repo, state === 'all' ? 'all' : state === 'closed' ? 'closed' : 'open');
    if (sort === 'created') {
      issues = [...issues].sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt || a.number - b.number : b.createdAt - a.createdAt || b.number - a.number));
    }
    const { pageItems, hasNext, total } = paginate(issues, page, perPage);
    const extra: Record<string, string> = {};
    const link = linkHeader(ctx.baseUrl, pathname, query, page, perPage, hasNext, total);
    if (link !== null) extra.link = link;
    return json(200, pageItems.map(issueToJson), extra);
  }
  const issueMatch = /^issues\/(\d+)(?:\/(comments))?$/.exec(sub);
  if (issueMatch !== null) {
    const number = Number.parseInt(issueMatch[1] as string, 10);
    const tail = issueMatch[2] as string | undefined;
    const issue = store.getIssue(repo, number);
    if (issue === undefined) return error(404, `issue ${number} not found`);
    if (tail === 'comments' && method === 'POST') {
      const bodyText = asString(input.body);
      if (bodyText === undefined) return error(422, 'body is required');
      const comment = store.createIssueComment(repo, number, bodyText);
      if (comment === undefined) return error(404, `issue ${number} not found`);
      return json(201, { id: comment.id, body: comment.body, user: { login: comment.author }, created_at: iso(comment.createdAt), updated_at: iso(comment.updatedAt) });
    }
    if (tail === 'comments' && method === 'GET') {
      return json(200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.author }, created_at: iso(c.createdAt), updated_at: iso(c.updatedAt) })));
    }
    if (tail === undefined && method === 'GET') return json(200, issueToJson(issue));
    if (tail === undefined && method === 'PATCH') {
      const state = asString(input.state);
      if (state === 'closed') {
        const closed = store.closeIssue(repo, number);
        if (closed === undefined) return error(404, `issue ${number} not found`);
        return json(200, issueToJson(closed));
      }
      if (state === 'open') {
        issue.state = 'open';
        issue.updatedAt = store.now();
        store.touch(repo);
        return json(200, issueToJson(issue));
      }
      return error(422, 'state must be open or closed');
    }
    return error(405, 'Method Not Allowed');
  }

  // Pull requests
  if (sub === 'pulls' && method === 'POST') {
    const title = asString(input.title);
    const head = asString(input.head);
    const base = asString(input.base);
    if (title === undefined || head === undefined || base === undefined) return error(422, 'title, head and base are required');
    const result = store.createPull(repo, { title, body: asString(input.body), head, base });
    if (!result.ok) return error(result.status, result.message);
    return json(201, pullToJson(result.pull));
  }
  if (sub === 'pulls' && method === 'GET') {
    const state = query.get('state') ?? 'open';
    const pulls = [...repo.pulls.values()]
      .filter((p) => (state === 'all' ? true : state === 'closed' ? p.state === 'closed' : p.state === 'open'))
      .sort((a, b) => a.number - b.number);
    return json(200, pulls.map(pullToJson));
  }
  const pullMatch = /^pulls\/(\d+)(?:\/(files|merge))?$/.exec(sub);
  if (pullMatch !== null) {
    const number = Number.parseInt(pullMatch[1] as string, 10);
    const tail = pullMatch[2] as string | undefined;
    const pull = store.getPull(repo, number);
    if (pull === undefined) return error(404, `pull request ${number} not found`);
    if (tail === 'files' && method === 'GET') return json(200, pull.files);
    if (tail === 'merge' && method === 'PUT') {
      const result = store.mergePull(repo, number);
      if (!result.ok) return error(result.status, result.message);
      return json(200, { merged: true, sha: result.sha, message: `Merge pull request #${number} from ${pull.headRef}` });
    }
    if (tail === undefined && method === 'GET') return json(200, pullToJson(pull));
    return error(405, 'Method Not Allowed');
  }

  return error(404, 'Not Found');
}
