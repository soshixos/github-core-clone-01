// The forge's in-memory state: one object store plus repositories with refs, issues, pull
// requests, labels and comments.
//
// The suite runs the entry on a fresh, empty forge and seeds every fixture through the API
// (REST, git push, GraphQL, MCP), so the store starts empty. Nothing here is pre-seeded; the
// only fixed data is the viewer identity (scenario.ts), which the token names.
//
// Determinism: every timestamp comes from a monotonic tick over the fixed scenario epoch, so two
// runs on the same instance produce byte-identical state exports. No Date.now, no Math.random.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor as gitIsAncestor,
  isObjectId,
  mergeBase as gitMergeBase,
  parseCommit,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';
import { FIXED_ISO, SCENARIO_EPOCH_SEC, VIEWER } from './scenario.ts';

export type IssueState = 'open' | 'closed';
export type PullState = 'open' | 'closed';

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly author: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: IssueState;
  readonly labels: string[];
  readonly author: string;
  readonly createdAt: number;
  updatedAt: number;
  readonly comments: IssueComment[];
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: PullState;
  merged: boolean;
  readonly headRef: string;
  headSha: string;
  readonly baseRef: string;
  baseSha: string;
  mergeSha: string | null;
  mergedAt: number | null;
  readonly author: string;
  readonly createdAt: number;
  updatedAt: number;
  files: PullFile[];
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: number;
  updatedAt: number;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  nextIssueNumber: number;
  nextCommentId: number;
  readonly pulls: Map<number, Pull>;
  nextPullNumber: number;
  readonly labels: Map<string, Label>;
  /** Pack cache: key -> pack bytes. Cleared on any mutation of this repo. */
  readonly packCache: Map<string, Buffer>;
}

export interface CreateRepoInput {
  readonly name: string;
  readonly description?: string;
  readonly private?: boolean;
}

export interface ContentResult {
  readonly status: 200 | 201;
  readonly contentSha: string;
  readonly commitSha: string;
  readonly path: string;
  readonly size: number;
}

export interface MergeResult {
  readonly ok: boolean;
  readonly sha?: string;
  readonly message?: string;
}

/** The REST/MCP JSON shape of an issue. */
export function issueToJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.author },
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
  };
}

/** The REST/MCP JSON shape of a pull request. */
export function pullToJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : iso(pull.mergedAt),
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: pull.author },
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
  };
}

/** The REST/MCP JSON shape of a repository. */
export function repoToJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** A line count used for pull-file change counts (additions/deletions are line based). */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Format an epoch second as an ISO 8601 string (GitHub's created_at shape). */
export function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

export class ForgeStore {
  /** Content-addressed object store, shared across repositories. */
  readonly objects = new Map<string, GitObject>();
  /** Repositories keyed by "owner/name". */
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  /** Global numeric ids for issues and pull requests (stable across reads). */
  private nextGlobalId = 10000;
  /** Monotonic deterministic clock: seconds since the scenario epoch. */
  private tick = 0;

  /** The next deterministic timestamp (epoch + tick), advancing the clock by one second. */
  now(): number {
    const t = SCENARIO_EPOCH_SEC + this.tick;
    this.tick += 1;
    return t;
  }

  /** The fixed scenario start, used for fields that must not advance the clock. */
  static epoch(): number {
    return SCENARIO_EPOCH_SEC;
  }

  // -------------------------------------------------------------------------------------------
  // objects
  // -------------------------------------------------------------------------------------------

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!this.objects.has(oid)) this.objects.set(oid, { type: object.type, data: object.data });
    }
  }

  /** Add every object in a pack buffer to the store; returns the object map. */
  ingestPack(pack: Buffer): Map<string, GitObject> {
    const objects = readPack(pack);
    this.putObjects(objects.values());
    return objects;
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(ForgeStore.repoKey(owner, name));
  }

  createRepo(owner: string, input: CreateRepoInput): Repo | null {
    if (this.getRepo(owner, input.name) !== undefined) return null;
    const now = this.now();
    const repo: Repo = {
      id: this.nextRepoId,
      name: input.name,
      owner,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      refs: new Map<string, string>(),
      issues: new Map<number, Issue>(),
      nextIssueNumber: 1,
      nextCommentId: 1,
      pulls: new Map<number, Pull>(),
      nextPullNumber: 1,
      labels: new Map<string, Label>(),
      packCache: new Map<string, Buffer>(),
    };
    this.nextRepoId += 1;
    this.repos.set(ForgeStore.repoKey(owner, input.name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(ForgeStore.repoKey(owner, name));
  }

  /** All repositories owned by a login, in creation order. */
  listUserRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  /** Clear the per-repo pack cache after any mutation. */
  touch(repo: Repo): void {
    repo.packCache.clear();
    repo.updatedAt = this.now();
  }

  // -------------------------------------------------------------------------------------------
  // refs and commits
  // -------------------------------------------------------------------------------------------

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    this.touch(repo);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const ok = repo.refs.delete(ref);
    if (ok) this.touch(repo);
    return ok;
  }

  defaultBranchRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headOid(repo: Repo, branch?: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch ?? repo.defaultBranch}`);
  }

  /** Create a commit object (authored by the viewer) and store it; returns its oid. */
  createCommit(tree: string, parents: string[], message: string, timestamp?: number): string {
    const ts = timestamp ?? this.now();
    const author = `${VIEWER.name} <${VIEWER.email}>`;
    const data = buildCommit({
      tree,
      parents,
      message,
      author,
      committer: author,
      timestamp: ts,
    });
    return this.putObject('commit', data);
  }

  /** Commits reachable from a tip, newest first (by deterministic creation order). */
  listCommits(repo: Repo, branch?: string): Array<{ sha: string; message: string; createdAt: number }> {
    const tip = this.headOid(repo, branch);
    if (tip === undefined || tip === ZERO_OID) return [];
    const reachable = collectReachable([tip], (oid) => this.getObject(oid), { allowMissing: true });
    const commits: Array<{ sha: string; message: string; createdAt: number; seq: number }> = [];
    // Creation order: objects were inserted into the store in push order; use the store's
    // insertion order as the sequence (Map preserves it).
    const order = new Map<string, number>();
    let i = 0;
    for (const oid of this.objects.keys()) order.set(oid, i++);
    for (const oid of reachable) {
      const object = this.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parsed = parseCommit(object.data);
      commits.push({ sha: oid, message: parsed.message, createdAt: 0, seq: order.get(oid) ?? 0 });
    }
    // Newest first: later-inserted objects first (push order == creation order).
    commits.sort((a, b) => b.seq - a.seq);
    return commits.map(({ sha, message, createdAt }) => ({ sha, message, createdAt }));
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return gitIsAncestor(ancestor, descendant, (oid) => this.getObject(oid));
  }

  mergeBase(a: string, b: string): string | null {
    return gitMergeBase(a, b, (oid) => this.getObject(oid));
  }

  // -------------------------------------------------------------------------------------------
  // trees and contents
  // -------------------------------------------------------------------------------------------

  /** Flatten a tree (recursively) to path -> { oid, mode }. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.getObject(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Read a blob at a path in a tree; returns undefined when the path is not a file. */
  readFileAt(treeOid: string, path: string): { oid: string; mode: string; data: Buffer } | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i++) {
      const object = this.getObject(current);
      if (object === undefined || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((e) => e.name === parts[i]);
      if (entry === undefined) return undefined;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return undefined;
        const blob = this.getObject(entry.oid);
        if (blob === undefined || blob.type !== 'blob') return undefined;
        return { oid: entry.oid, mode: entry.mode, data: blob.data };
      }
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** List the entries of a directory in a tree; undefined when the path is not a directory. */
  readDirAt(treeOid: string, path: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir' }> | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (const part of parts) {
      const object = this.getObject(current);
      if (object === undefined || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((e) => e.name === part);
      if (entry === undefined || entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    const object = this.getObject(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    return parseTree(object.data).map((entry) => ({
      name: entry.name,
      path: parts.length === 0 ? entry.name : `${parts.join('/')}/${entry.name}`,
      sha: entry.oid,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  /**
   * Return a new root tree with `path` set to `blobOid` (or deleted when null), writing every
   * intermediate tree it creates. The original tree is untouched.
   */
  updateTreeAt(treeOid: string, path: string, blobOid: string | null, mode = '100644'): string {
    const parts = path.split('/').filter((p) => p !== '');
    const build = (oid: string | undefined, depth: number): string | null => {
      const entries = oid === undefined ? [] : parseTree(this.getObject(oid)?.data ?? Buffer.alloc(0));
      const name = parts[depth];
      const rest = parts.slice(depth + 1);
      const next = entries.filter((e) => e.name !== name);
      if (rest.length === 0) {
        if (blobOid !== null) next.push({ mode, name, oid: blobOid });
        if (next.length === 0) return null;
        return this.putObject('tree', buildTree(next));
      }
      const child = entries.find((e) => e.name === name);
      const childOid = child !== undefined && child.mode === '40000' ? child.oid : undefined;
      const rebuilt = build(childOid, depth + 1);
      if (rebuilt !== null) next.push({ mode: '40000', name, oid: rebuilt });
      if (next.length === 0) return null;
      return this.putObject('tree', buildTree(next));
    };
    const root = build(treeOid === ZERO_OID ? undefined : treeOid, 0);
    if (root === null) {
      // Empty tree.
      return this.putObject('tree', buildTree([]));
    }
    return root;
  }

  /** The empty tree's oid (well-known). */
  emptyTreeOid(): string {
    return this.putObject('tree', buildTree([]));
  }

  // -------------------------------------------------------------------------------------------
  // contents (REST)
  // -------------------------------------------------------------------------------------------

  /**
   * Create or update a file at `path` on `branch` (default branch when omitted). Returns the
   * content blob sha, the new commit sha, and whether it was a create (201) or an update (200).
   * `expectedSha` enforces the optimistic-concurrency check: a stale sha is a 409.
   */
  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch?: string,
    expectedSha?: string,
  ): { ok: true; result: ContentResult } | { ok: false; status: 404 | 409 } {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    const tip = repo.refs.get(ref);
    const existing = tip !== undefined && tip !== ZERO_OID ? this.readFileAt(parseCommit(this.getObject(tip)?.data ?? Buffer.alloc(0)).tree, path) : undefined;
    if (expectedSha !== undefined) {
      if (existing === undefined || existing.oid !== expectedSha) return { ok: false, status: 409 };
    }
    const blobOid = this.putObject('blob', content);
    const baseTree = tip !== undefined && tip !== ZERO_OID ? parseCommit(this.getObject(tip)?.data ?? Buffer.alloc(0)).tree : this.emptyTreeOid();
    const newTree = this.updateTreeAt(baseTree, path, blobOid);
    const parents = tip !== undefined && tip !== ZERO_OID ? [tip] : [];
    const commitSha = this.createCommit(newTree, parents, message);
    repo.refs.set(ref, commitSha);
    this.touch(repo);
    return {
      ok: true,
      result: {
        status: existing === undefined ? 201 : 200,
        contentSha: blobOid,
        commitSha,
        path,
        size: content.length,
      },
    };
  }

  deleteContent(repo: Repo, path: string, message: string, branch?: string, expectedSha?: string): { ok: true; commitSha: string } | { ok: false; status: 404 | 409 } {
    const ref = `refs/heads/${branch ?? repo.defaultBranch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined || tip === ZERO_OID) return { ok: false, status: 404 };
    const tree = parseCommit(this.getObject(tip)?.data ?? Buffer.alloc(0)).tree;
    const existing = this.readFileAt(tree, path);
    if (existing === undefined) return { ok: false, status: 404 };
    if (expectedSha !== undefined && existing.oid !== expectedSha) return { ok: false, status: 409 };
    const newTree = this.updateTreeAt(tree, path, null);
    const commitSha = this.createCommit(newTree, [tip], message);
    repo.refs.set(ref, commitSha);
    this.touch(repo);
    return { ok: true, commitSha };
  }

  // -------------------------------------------------------------------------------------------
  // labels
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color = '000000', description = ''): Label {
    const label: Label = { name, color, description };
    repo.labels.set(name, label);
    this.touch(repo);
    return label;
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  // -------------------------------------------------------------------------------------------
  // issues and comments
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, input: IssueInput): { ok: true; issue: Issue } | { ok: false; status: 422; message: string } {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) {
        return { ok: false, status: 422, message: `label ${JSON.stringify(name)} does not exist` };
      }
    }
    const now = this.now();
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextIssueNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...labels],
      author: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.nextGlobalId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.set(issue.number, issue);
    this.touch(repo);
    return { ok: true, issue };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  /** Issues in creation order (ascending number), optionally filtered by state. */
  listIssues(repo: Repo, state?: 'open' | 'closed' | 'all'): Issue[] {
    const all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    if (state === undefined || state === 'all') return all;
    return all.filter((issue) => issue.state === state);
  }

  closeIssue(repo: Repo, number: number): Issue | undefined {
    const issue = repo.issues.get(number);
    if (issue === undefined) return undefined;
    issue.state = 'closed';
    issue.updatedAt = this.now();
    this.touch(repo);
    return issue;
  }

  createIssueComment(repo: Repo, number: number, body: string): IssueComment | undefined {
    const issue = repo.issues.get(number);
    if (issue === undefined) return undefined;
    const now = this.now();
    const comment: IssueComment = {
      id: repo.nextCommentId,
      body,
      author: VIEWER.login,
      createdAt: now,
      updatedAt: now,
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedAt = now;
    this.touch(repo);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  /** Diff two trees into the pull-file list (filename, status, line counts). */
  diffTrees(baseTree: string, headTree: string): PullFile[] {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const files: PullFile[] = [];
    const names = new Set<string>([...base.keys(), ...head.keys()]);
    for (const name of [...names].sort()) {
      const b = base.get(name);
      const h = head.get(name);
      if (b !== undefined && h === undefined) {
        const old = this.getObject(b.oid);
        const deletions = old !== undefined ? lineCount(old.data) : 0;
        files.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b === undefined && h !== undefined) {
        const added = this.getObject(h.oid);
        const additions = added !== undefined ? lineCount(added.data) : 0;
        files.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const old = this.getObject(b.oid);
        const added = this.getObject(h.oid);
        const additions = added !== undefined ? lineCount(added.data) : 0;
        const deletions = old !== undefined ? lineCount(old.data) : 0;
        files.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  createPull(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): { ok: true; pull: Pull } | { ok: false; status: 404 | 422; message: string } {
    const headSha = repo.refs.get(`refs/heads/${input.head}`);
    const baseSha = repo.refs.get(`refs/heads/${input.base}`);
    if (headSha === undefined || baseSha === undefined) {
      return { ok: false, status: 404, message: 'head or base branch not found' };
    }
    const headTree = parseCommit(this.getObject(headSha)?.data ?? Buffer.alloc(0)).tree;
    const baseTree = parseCommit(this.getObject(baseSha)?.data ?? Buffer.alloc(0)).tree;
    const now = this.now();
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextPullNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      mergeSha: null,
      mergedAt: null,
      author: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      files: this.diffTrees(baseTree, headTree),
    };
    this.nextGlobalId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.set(pull.number, pull);
    this.touch(repo);
    return { ok: true, pull };
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  /** True when head and base both changed the same file differently since the merge base. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const base = this.mergeBase(pull.headSha, pull.baseSha);
    if (base === null) return false;
    const baseTree = parseCommit(this.getObject(base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(this.getObject(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
    const baseTreeOf = parseCommit(this.getObject(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
    const baseFiles = this.flattenTree(baseTree);
    const headFiles = this.flattenTree(headTree);
    const baseBranchFiles = this.flattenTree(baseTreeOf);
    const names = new Set<string>([...headFiles.keys(), ...baseBranchFiles.keys()]);
    for (const name of names) {
      const fromBase = baseFiles.get(name)?.oid;
      const inHead = headFiles.get(name)?.oid;
      const inBase = baseBranchFiles.get(name)?.oid;
      const headChanged = inHead !== fromBase;
      const baseChanged = inBase !== fromBase;
      if (headChanged && baseChanged && inHead !== inBase) return true;
    }
    return false;
  }

  /**
   * Squash-merge an open pull request onto its base branch: one commit whose tree is the head
   * tree, whose message is the pull title, parented on the base tip. Returns 405 on conflict.
   */
  mergePull(repo: Repo, number: number): { ok: true; pull: Pull; sha: string } | { ok: false; status: 404 | 405; message: string } {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return { ok: false, status: 404, message: 'pull request not found' };
    if (pull.state !== 'open') return { ok: false, status: 405, message: 'pull request is not open' };
    // Refresh the head/base tips (branches may have moved since the pull was created).
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const live: Pull = { ...pull, headSha, baseSha };
    if (this.pullConflicts(repo, live)) {
      return { ok: false, status: 405, message: 'merge conflict' };
    }
    const headTree = parseCommit(this.getObject(headSha)?.data ?? Buffer.alloc(0)).tree;
    const sha = this.createCommit(headTree, [baseSha], pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = sha;
    pull.mergedAt = this.now();
    pull.headSha = headSha;
    pull.baseSha = baseSha;
    pull.updatedAt = this.now();
    this.touch(repo);
    return { ok: true, pull, sha };
  }

  // -------------------------------------------------------------------------------------------
  // pack building for fetch / clone (with a per-repo cache for identical requests)
  // -------------------------------------------------------------------------------------------

  /**
   * Build the pack for a fetch: objects reachable from `wants` minus objects reachable from
   * `haves`, optionally limited to `depth` generations from each want (shallow). The client's
   * shallow boundaries (`clientShallow`) cut its history off: it holds those commits but none of
   * their ancestors, so the ancestors are not treated as "had" even when a boundary is listed
   * as a have. Results are cached per repo+request so the 50 concurrent identical shallow
   * clones share one build.
   */
  packFor(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth?: number,
    clientShallow: string[] = [],
  ): { pack: Buffer; shallow: string[] } {
    const key = [
      wants.slice().sort().join(','),
      haves.slice().sort().join(','),
      depth === undefined ? '' : String(depth),
      clientShallow.slice().sort().join(','),
    ].join('|');
    const cached = repo.packCache.get(key);
    if (cached !== undefined) {
      // The shallow boundary is recomputed cheaply below; the pack itself is cached.
      const shallow = this.shallowBoundary(wants, haves, depth);
      return { pack: cached, shallow };
    }
    const { objects, shallow } = this.collectForFetch(wants, haves, depth, clientShallow);
    const pack = writePack([...objects.values()].map((o) => ({ type: o.type, data: o.data })));
    repo.packCache.set(key, pack);
    return { pack, shallow };
  }

  /**
   * The shallow boundary oids for a depth-limited fetch: the commits exactly `depth - 1`
   * generations below each want (depth 1 names the tip itself; depth 2 names its parents).
   * A want whose history ends before that generation contributes no boundary oid.
   */
  shallowBoundary(wants: string[], _haves: string[], depth?: number): string[] {
    if (depth === undefined || depth <= 0) return [];
    const boundary: string[] = [];
    for (const want of wants) boundary.push(...this.commitsAtDepth(want, depth - 1));
    return [...new Set(boundary)];
  }

  /** Commits exactly `generations` below `tip` (generation 0 is the tip itself). */
  private commitsAtDepth(tip: string, generations: number): string[] {
    let frontier = [tip];
    for (let d = 0; d < generations; d++) {
      const next: string[] = [];
      for (const oid of frontier) {
        const object = this.getObject(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) next.push(parent);
      }
      frontier = next;
      if (frontier.length === 0) return [];
    }
    return frontier;
  }

  /**
   * Objects to send for a fetch, honoring haves and an optional depth limit. A commit is sent
   * when its shortest distance from a want is at most `depth - 1` generations (depth 1 sends
   * only the tip); its tree and blobs are always sent with it. Nothing the client already has
   * is sent — except that a shallow boundary's ancestors are never "had", even when the
   * boundary itself is listed as a have (a deepen must deliver exactly those ancestors).
   */
  private collectForFetch(
    wants: string[],
    haves: string[],
    depth?: number,
    clientShallow: string[] = [],
  ): { objects: Map<string, GitObject>; shallow: string[] } {
    const haveReachable = new Set<string>();
    if (haves.length > 0) {
      collectReachable(haves, (oid) => this.getObject(oid), { allowMissing: true }).forEach((oid) => haveReachable.add(oid));
    }
    // Cut the "had" set off at every shallow boundary: the client holds the boundary commit
    // itself, but none of its ancestors.
    for (const boundary of clientShallow) {
      const object = this.getObject(boundary);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        collectReachable([parent], (oid) => this.getObject(oid), { allowMissing: true }).forEach((oid) => haveReachable.delete(oid));
      }
    }
    const shallow = this.shallowBoundary(wants, haves, depth);
    const shallowSet = new Set(shallow);
    // Shortest distance (in commit generations) from any want, by BFS. The traversal runs
    // through every commit within the depth limit — including ones the client already has —
    // because a shallow boundary the client holds still has ancestors it does not hold (a
    // deepen must deliver exactly those). Only the *sending* is filtered by haveReachable.
    const distance = new Map<string, number>();
    const queue: string[] = [];
    for (const want of wants) {
      if (want === ZERO_OID) continue;
      if (!distance.has(want)) {
        distance.set(want, 0);
        queue.push(want);
      }
    }
    const include = new Set<string>();
    for (let qi = 0; qi < queue.length; qi++) {
      const oid = queue[qi] as string;
      const d = distance.get(oid) as number;
      if (depth !== undefined && d > depth - 1) continue;
      if (!haveReachable.has(oid)) include.add(oid);
      if (shallowSet.has(oid)) continue;
      if (depth !== undefined && d >= depth - 1) continue;
      const object = this.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
    const objects = new Map<string, GitObject>();
    const seen = new Set<string>();
    for (const oid of include) {
      const object = this.getObject(oid);
      if (object === undefined) continue;
      objects.set(oid, object);
      if (object.type === 'commit') {
        const parsed = parseCommit(object.data);
        this.addTreeObjects(parsed.tree, objects, seen);
      } else if (object.type === 'tree') {
        this.addTreeObjects(oid, objects, seen);
      } else if (object.type === 'tag') {
        const target = this.tagTarget(object.data);
        if (target !== undefined && !haveReachable.has(target)) {
          const targetObject = this.getObject(target);
          if (targetObject !== undefined) {
            objects.set(target, targetObject);
            if (targetObject.type === 'commit') {
              this.addTreeObjects(parseCommit(targetObject.data).tree, objects, seen);
            }
          }
        }
      }
    }
    // Send exactly the objects reachable from a sent commit minus the objects the client
    // already holds. The `include` set already encodes the commit-level filter; this pass
    // applies the same filter to the trees and blobs, so an incremental fetch never re-sends
    // an unchanged file the client already has.
    for (const oid of haveReachable) objects.delete(oid);
    return { objects, shallow };
  }

  private addTreeObjects(treeOid: string, objects: Map<string, GitObject>, seen: Set<string>): void {
    const object = this.getObject(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    if (!objects.has(treeOid)) objects.set(treeOid, object);
    seen.add(treeOid);
    for (const entry of parseTree(object.data)) {
      const child = this.getObject(entry.oid);
      if (child === undefined) continue;
      if (entry.mode === '40000') {
        this.addTreeObjects(entry.oid, objects, seen);
      } else if (!objects.has(entry.oid)) {
        objects.set(entry.oid, child);
      }
    }
  }

  private tagTarget(data: Buffer): string | undefined {
    const text = data.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    return match === null ? undefined : match[1];
  }
}


