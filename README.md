# github-core-clone-01 — a GitHub-compatible git forge

A single Node 22 process (stdlib only, no dependencies, no git binary, no outside service)
serving a GitHub-compatible git forge: smart HTTP clone/push, REST v3, GraphQL, and MCP,
from its own in-memory store.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the kit starter's lifecycle (unchanged): it binds an ephemeral port, registers
it with `$MAKEFUN_ENV_URL`, and exits when the env says done. `MAKEFUN_SHOP_TOKEN` is the
one bearer token; when it is set, API calls must carry it.

## Surface

- `GET /healthz` — `200 {"ok":true}`, no auth.
- `GET /api/v3/` — API root (`X-Oauth-Scopes: repo, read:org`).
- `GET /api/v3/meta` — `{"installed_version": ...}`.
- `GET /api/v3/user`, `POST /api/v3/user/repos`, `GET /api/v3/user/repos` (paginated).
- `/api/v3/repos/{owner}/{repo}` — repos, branches, commits, contents, labels, issues,
  comments, pull requests, files, merge (squash).
- `POST /api/graphql` — queries, mutations, `__type` introspection, batching.
- `POST /mcp` — `server/discover`, `initialize`, `tools/list`, `tools/call`.
- `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack` — git smart HTTP,
  protocol v0 and v2, plain (non-delta) packs, shallow/deepen, fast-forward push rules.

## Layout

- `main.ts` — lifecycle (kit starter, unchanged).
- `app.ts` — HTTP server and router.
- `lib/scenario.ts` — the seeded scenario: the viewer identity derived from the fixed
  scenario seed (the only token→login mapping in the system).
- `lib/gitobj.ts` — git objects (hash/tree/commit/tag), pack read/write (plain objects),
  pkt-lines, reachability.
- `lib/store.ts` — the in-memory forge: objects, repositories, refs, issues, pull requests,
  labels, comments, deterministic clock, pack building with a per-repo cache.
- `lib/git-http.ts` — smart HTTP: v0/v2 advertisements, upload-pack fetch, receive-pack push.
- `lib/rest.ts` — REST v3.
- `lib/graphql.ts` — a small GraphQL engine for the gh / github-mcp-server documents.
- `lib/mcp.ts` — MCP tools: create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request.

## Determinism

Every timestamp comes from a monotonic tick over the fixed scenario epoch, so two runs on
the same instance leave identical state. No `Date.now`, no `Math.random`, no process values
in any response body.

## Grade locally

```sh
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf]
```
