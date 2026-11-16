// GraphQL over /api/graphql: a small hand-written engine for exactly the documents gh and
// github-mcp-server send (queries, mutations, variables, inline fragments, batching, __type).
// Unknown fields answer HTTP 200 with an `errors` array naming the field, never HTTP 400.
// Unknown repositories answer data.repository = null with no errors. Global ids are opaque
// base64 of a type-tagged key, stable across reads. No-auth is 401 (checked by app.ts).

import { ForgeStore, type Issue, type Pull, type Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

// -------------------------------------------------------------------------------------------
// tokenizer
// -------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // A GraphQL string (block strings are not used by the suite's documents).
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// AST + parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'null' }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ValueNode>> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Readonly<Record<string, ValueNode>>;
  readonly selectionSet: SelectionSetNode | null;
}

interface InlineFragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selectionSet: SelectionSetNode;
}

interface SpreadNode {
  readonly kind: 'spread';
  readonly name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface SelectionSetNode {
  readonly kind: 'selectionSet';
  readonly selections: readonly SelectionNode[];
}

interface OperationNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableDefinitions: Readonly<Record<string, ValueNode | null>>;
  readonly selectionSet: SelectionSetNode;
}

interface FragmentDefinitionNode {
  readonly kind: 'fragmentDefinition';
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: SelectionSetNode;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Record<string, FragmentDefinitionNode> } {
    const operations: OperationNode[] = [];
    const fragments: Record<string, FragmentDefinitionNode> = {};
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push(this.parseOperation('query', null));
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        operations.push(this.parseOperation(operation, name));
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selectionSet = this.parseSelectionSet();
        fragments[name] = { kind: 'fragmentDefinition', name, typeCondition, selectionSet };
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token.value)}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(operation: 'query' | 'mutation', name: string | null): OperationNode {
    const variableDefinitions: Record<string, ValueNode | null> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        // The variable type: a name, possibly wrapped in [ ] and !. We record only the name.
        this.skipType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions[varName] = defaultValue;
      }
      this.expectPunct(')');
    }
    const selectionSet = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variableDefinitions, selectionSet };
  }

  private skipType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.skipType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error(`expected a type, got ${JSON.stringify(token.value)}`);
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionSetNode {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return { kind: 'selectionSet', selections };
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'fragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not used by the suite's documents; skip them if present.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selectionSet: SelectionSetNode | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

/** Resolve a value node to a plain JS value, substituting variables. */
function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// global ids (opaque, stable)
// -------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoId(repo: Repo): string {
  return encodeGlobalId('Repository', `${repo.owner}/${repo.name}`);
}

function issueId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

function pullId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
}

function commentId(repo: Repo, issue: Issue, commentIdNumber: number): string {
  return encodeGlobalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${commentIdNumber}`);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// node shapes (every object value carries its GraphQL type in __type)
// -------------------------------------------------------------------------------------------

type NodeValue =
  | { readonly __type: 'Query' }
  | { readonly __type: 'Mutation' }
  | { readonly __type: 'User'; readonly login: string; readonly id: number; readonly name: string; readonly email: string }
  | { readonly __type: 'Repository'; readonly repo: Repo }
  | { readonly __type: 'RepositoryOwner'; readonly login: string }
  | { readonly __type: 'Ref'; readonly name: string }
  | { readonly __type: 'Issue'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __type: 'PullRequest'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __type: 'IssueConnection'; readonly repo: Repo; readonly items: Issue[]; readonly pageInfo: PageInfoValue }
  | { readonly __type: 'PullRequestConnection'; readonly repo: Repo; readonly items: Pull[]; readonly pageInfo: PageInfoValue }
  | { readonly __type: 'PullRequestFileConnection'; readonly files: readonly { filename: string; status: string; additions: number; deletions: number }[] }
  | { readonly __type: 'PullRequestFile'; readonly file: { filename: string; status: string; additions: number; deletions: number } }
  | { readonly __type: 'PageInfo'; readonly hasNextPage: boolean; readonly endCursor: string | null; readonly hasPreviousPage: boolean; readonly startCursor: string | null }
  | { readonly __type: '__Type'; readonly name: string; readonly kind: string; readonly fields: string[]; readonly enumValues: string[] }
  | { readonly __type: '__Field'; readonly name: string }
  | { readonly __type: '__EnumValue'; readonly name: string }
  | { readonly __type: 'IssueComment'; readonly repo: Repo; readonly issue: Issue; readonly commentIdNumber: number; readonly body: string }
  | { readonly __type: 'IssueCommentEdge'; readonly repo: Repo; readonly issue: Issue; readonly commentIdNumber: number; readonly body: string }
  | { readonly __type: 'AddCommentPayload'; readonly repo: Repo; readonly issue: Issue; readonly commentIdNumber: number; readonly body: string }
  | { readonly __type: 'CreateIssuePayload'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __type: 'CloseIssuePayload'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __type: 'CreatePullRequestPayload'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __type: 'MergePullRequestPayload'; readonly repo: Repo; readonly pull: Pull };

interface PageInfoValue {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly hasPreviousPage: boolean;
  readonly startCursor: string | null;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(store: ForgeStore, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

// -------------------------------------------------------------------------------------------
// schema: field resolvers per type
// -------------------------------------------------------------------------------------------

interface FieldDef {
  /** The GraphQL type of the result ('String' | 'Int' | 'Boolean' | 'ID' | a node type). */
  readonly type: string;
  readonly list?: boolean;
  readonly resolve: (parent: NodeValue, args: Record<string, unknown>, store: ForgeStore) => unknown;
}

function scalar(type: string, resolve: (parent: NodeValue, args: Record<string, unknown>, store: ForgeStore) => unknown): FieldDef {
  return { type, resolve };
}

function object(type: string, resolve: (parent: NodeValue, args: Record<string, unknown>, store: ForgeStore) => unknown): FieldDef {
  return { type, resolve };
}

function listOf(type: string, resolve: (parent: NodeValue, args: Record<string, unknown>, store: ForgeStore) => unknown): FieldDef {
  return { type, list: true, resolve };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function issueConnection(repo: Repo, issues: Issue[], first: number | undefined, after: string | null | undefined): NodeValue {
  const sorted = [...issues].sort((a, b) => a.number - b.number);
  const afterNumber = numberFromCursor(after);
  const startIndex = afterNumber === null ? 0 : sorted.findIndex((i) => i.number === afterNumber) + 1;
  const page = first === undefined ? sorted.slice(startIndex) : sorted.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < sorted.length;
  const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]?.number ?? 0);
  const startCursor = page.length === 0 ? null : cursorFor(page[0]?.number ?? 0);
  return {
    __type: 'IssueConnection',
    repo,
    items: page,
    pageInfo: { hasNextPage, endCursor, hasPreviousPage: startIndex > 0, startCursor },
  };
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: object('User', () => ({ __type: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email })),
    repository: object('Repository', (_parent, args, store) => {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : { __type: 'Repository', repo };
    }),
    node: object('Node', (_parent, args, store) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const [owner, name] = decoded.key.split('/');
        if (owner === undefined || name === undefined) return null;
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : { __type: 'Repository', repo };
      }
      if (decoded.kind === 'Issue') {
        const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
        if (match === null) return null;
        const repo = store.getRepo(match[1] as string, match[2] as string);
        const issue = repo === undefined ? undefined : store.getIssue(repo, Number.parseInt(match[3] as string, 10));
        return repo === undefined || issue === undefined ? null : { __type: 'Issue', repo, issue };
      }
      if (decoded.kind === 'PullRequest') {
        const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
        if (match === null) return null;
        const repo = store.getRepo(match[1] as string, match[2] as string);
        const pull = repo === undefined ? undefined : store.getPull(repo, Number.parseInt(match[3] as string, 10));
        return repo === undefined || pull === undefined ? null : { __type: 'PullRequest', repo, pull };
      }
      return null;
    }),
    __type: object('__Type', (_parent, args) => {
      const name = String(args.name ?? '');
      if (name === 'SearchType') return { __type: '__Type', name, kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES };
      const fields = TYPE_FIELDS[name];
      if (fields === undefined) return null;
      return { __type: '__Type', name, kind: 'OBJECT', fields, enumValues: [] };
    }),
  },
  Mutation: {
    createIssue: object('CreateIssuePayload', (_parent, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createIssue: repositoryId does not name a repository');
      const [owner, name] = decoded.key.split('/');
      const repo = owner === undefined || name === undefined ? undefined : store.getRepo(owner, name);
      if (repo === undefined) throw new Error('createIssue: repository not found');
      const result = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      if (!result.ok) throw new Error(`createIssue: ${result.message}`);
      return { __type: 'CreateIssuePayload', repo, issue: result.issue };
    }),
    closeIssue: object('CloseIssuePayload', (_parent, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('closeIssue: issueId does not name an issue');
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) throw new Error('closeIssue: bad issue id');
      const repo = store.getRepo(match[1] as string, match[2] as string);
      const issue = repo === undefined ? undefined : store.closeIssue(repo, Number.parseInt(match[3] as string, 10));
      if (repo === undefined || issue === undefined) throw new Error('closeIssue: issue not found');
      return { __type: 'CloseIssuePayload', repo, issue };
    }),
    createPullRequest: object('CreatePullRequestPayload', (_parent, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createPullRequest: repositoryId does not name a repository');
      const [owner, name] = decoded.key.split('/');
      const repo = owner === undefined || name === undefined ? undefined : store.getRepo(owner, name);
      if (repo === undefined) throw new Error('createPullRequest: repository not found');
      const result = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (!result.ok) throw new Error(`createPullRequest: ${result.message}`);
      return { __type: 'CreatePullRequestPayload', repo, pull: result.pull };
    }),
    mergePullRequest: object('MergePullRequestPayload', (_parent, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: pullRequestId does not name a pull request');
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) throw new Error('mergePullRequest: bad pull request id');
      const repo = store.getRepo(match[1] as string, match[2] as string);
      if (repo === undefined) throw new Error('mergePullRequest: repository not found');
      const result = store.mergePull(repo, Number.parseInt(match[3] as string, 10));
      if (!result.ok) throw new Error(`mergePullRequest: ${result.message}`);
      return { __type: 'MergePullRequestPayload', repo, pull: result.pull };
    }),
    addComment: object('AddCommentPayload', (_parent, args, store) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('addComment: subjectId does not name an issue');
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (match === null) throw new Error('addComment: bad subject id');
      const repo = store.getRepo(match[1] as string, match[2] as string);
      const issue = repo === undefined ? undefined : store.getIssue(repo, Number.parseInt(match[3] as string, 10));
      if (repo === undefined || issue === undefined) throw new Error('addComment: issue not found');
      const comment = store.createIssueComment(repo, issue.number, String(input.body ?? ''));
      if (comment === undefined) throw new Error('addComment: issue not found');
      return { __type: 'AddCommentPayload', repo, issue, commentIdNumber: comment.id, body: comment.body };
    }),
  },
  User: {
    login: scalar('String', (p) => (p as { login: string }).login),
    id: scalar('ID', (p) => String((p as { id: number }).id)),
    name: scalar('String', (p) => (p as { name: string }).name),
    email: scalar('String', (p) => (p as { email: string }).email),
  },
  RepositoryOwner: {
    login: scalar('String', (p) => (p as { login: string }).login),
  },
  Ref: {
    name: scalar('String', (p) => (p as { name: string }).name),
  },
  Repository: {
    id: scalar('ID', (p) => repoId((p as { repo: Repo }).repo)),
    databaseId: scalar('Int', (p) => (p as { repo: Repo }).repo.id),
    name: scalar('String', (p) => (p as { repo: Repo }).repo.name),
    nameWithOwner: scalar('String', (p) => `${(p as { repo: Repo }).repo.owner}/${(p as { repo: Repo }).repo.name}`),
    owner: object('RepositoryOwner', (p) => ({ __type: 'RepositoryOwner', login: (p as { repo: Repo }).repo.owner })),
    defaultBranchRef: object('Ref', (p) => ({ __type: 'Ref', name: (p as { repo: Repo }).repo.defaultBranch })),
    viewerPermission: scalar('String', () => 'ADMIN'),
    hasIssuesEnabled: scalar('Boolean', () => true),
    issue: object('Issue', (p, args, store) => {
      const repo = (p as { repo: Repo }).repo;
      const issue = store.getIssue(repo, Number(args.number ?? 0));
      return issue === undefined ? null : { __type: 'Issue', repo, issue };
    }),
    issues: object('IssueConnection', (p, args, store) => {
      const repo = (p as { repo: Repo }).repo;
      const states = args.states as string[] | undefined;
      let issues = store.listIssues(repo, 'all');
      if (states !== undefined && states.length > 0) {
        const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s)));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.direction === 'DESC') issues = [...issues].sort((a, b) => b.number - a.number);
      else if (orderBy?.direction === 'ASC') issues = [...issues].sort((a, b) => a.number - b.number);
      const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
      const after = args.after === undefined || args.after === null ? null : String(args.after);
      // The cursor path already slices in creation order; for DESC the cursor is applied on the
      // sorted list below by re-slicing with the same helper on the sorted array.
      if (orderBy?.direction === 'DESC') {
        const sorted = [...issues];
        const afterNumber = numberFromCursor(after);
        const startIndex = afterNumber === null ? 0 : sorted.findIndex((i) => i.number === afterNumber) + 1;
        const page = first === undefined ? sorted.slice(startIndex) : sorted.slice(startIndex, startIndex + first);
        const hasNextPage = startIndex + page.length < sorted.length;
        const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]?.number ?? 0);
        const startCursor = page.length === 0 ? null : cursorFor(page[0]?.number ?? 0);
        return { __type: 'IssueConnection', repo, items: page, pageInfo: { hasNextPage, endCursor, hasPreviousPage: startIndex > 0, startCursor } };
      }
      return issueConnection(repo, issues, first, after);
    }),
    pullRequests: object('PullRequestConnection', (p, args) => {
      const repo = (p as { repo: Repo }).repo;
      const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
      const page = first === undefined ? pulls : pulls.slice(0, first);
      return {
        __type: 'PullRequestConnection',
        repo,
        items: page,
        pageInfo: { hasNextPage: first !== undefined && pulls.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
      };
    }),
    pullRequest: object('PullRequest', (p, args, store) => {
      const repo = (p as { repo: Repo }).repo;
      const pull = store.getPull(repo, Number(args.number ?? 0));
      return pull === undefined ? null : { __type: 'PullRequest', repo, pull };
    }),
  },
  Issue: {
    id: scalar('ID', (p) => issueId((p as { repo: Repo; issue: Issue }).repo, (p as { repo: Repo; issue: Issue }).issue)),
    number: scalar('Int', (p) => (p as { issue: Issue }).issue.number),
    title: scalar('String', (p) => (p as { issue: Issue }).issue.title),
    state: scalar('String', (p) => issueState((p as { issue: Issue }).issue)),
    body: scalar('String', (p) => (p as { issue: Issue }).issue.body),
  },
  IssueConnection: {
    nodes: listOf('Issue', (p) => (p as { repo: Repo; items: Issue[] }).items.map((issue) => ({ __type: 'Issue', repo: (p as { repo: Repo }).repo, issue }) as NodeValue)),
    pageInfo: object('PageInfo', (p) => ({ __type: 'PageInfo', ...(p as { pageInfo: PageInfoValue }).pageInfo })),
    totalCount: scalar('Int', (p) => (p as { items: unknown[] }).items.length),
  },
  PullRequestConnection: {
    nodes: listOf('PullRequest', (p) => (p as { repo: Repo; items: Pull[] }).items.map((pull) => ({ __type: 'PullRequest', repo: (p as { repo: Repo }).repo, pull }) as NodeValue)),
    pageInfo: object('PageInfo', (p) => ({ __type: 'PageInfo', ...(p as { pageInfo: PageInfoValue }).pageInfo })),
    totalCount: scalar('Int', (p) => (p as { items: unknown[] }).items.length),
  },
  PullRequest: {
    id: scalar('ID', (p) => pullId((p as { repo: Repo; pull: Pull }).repo, (p as { repo: Repo; pull: Pull }).pull)),
    number: scalar('Int', (p) => (p as { pull: Pull }).pull.number),
    state: scalar('String', (p) => pullState((p as { pull: Pull }).pull)),
    merged: scalar('Boolean', (p) => (p as { pull: Pull }).pull.merged),
    headRefName: scalar('String', (p) => (p as { pull: Pull }).pull.headRef),
    baseRefName: scalar('String', (p) => (p as { pull: Pull }).pull.baseRef),
    mergeable: scalar('String', (p, _args, store) => pullMergeable(store, (p as { repo: Repo }).repo, (p as { pull: Pull }).pull)),
    files: object('PullRequestFileConnection', (p, args) => {
      const pull = (p as { pull: Pull }).pull;
      const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
      const files = first === undefined ? pull.files : pull.files.slice(0, first);
      return { __type: 'PullRequestFileConnection', files };
    }),
  },
  PullRequestFileConnection: {
    nodes: listOf('PullRequestFile', (p) => (p as { files: readonly { filename: string; status: string; additions: number; deletions: number }[] }).files.map((file) => ({ __type: 'PullRequestFile', file }) as NodeValue)),
    pageInfo: object('PageInfo', () => ({ __type: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null })),
    totalCount: scalar('Int', (p) => (p as { files: unknown[] }).files.length),
  },
  PullRequestFile: {
    path: scalar('String', (p) => (p as { file: { filename: string } }).file.filename),
    additions: scalar('Int', (p) => (p as { file: { additions: number } }).file.additions),
    deletions: scalar('Int', (p) => (p as { file: { deletions: number } }).file.deletions),
    changeType: scalar('String', (p) => {
      const status = (p as { file: { status: string } }).file.status;
      return status === 'added' ? 'ADDED' : status === 'removed' ? 'REMOVED' : 'MODIFIED';
    }),
  },
  PageInfo: {
    hasNextPage: scalar('Boolean', (p) => (p as { hasNextPage: boolean }).hasNextPage),
    endCursor: scalar('String', (p) => (p as { endCursor: string | null }).endCursor),
    hasPreviousPage: scalar('Boolean', (p) => (p as { hasPreviousPage: boolean }).hasPreviousPage),
    startCursor: scalar('String', (p) => (p as { startCursor: string | null }).startCursor),
  },
  __Type: {
    name: scalar('String', (p) => (p as { name: string }).name),
    kind: scalar('String', (p) => (p as { kind: string }).kind),
    fields: listOf('__Field', (p, args) => {
      void args;
      return (p as { fields: string[] }).fields.map((name) => ({ __type: '__Field', name }) as NodeValue);
    }),
    enumValues: listOf('__EnumValue', (p) => (p as { enumValues: string[] }).enumValues.map((name) => ({ __type: '__EnumValue', name }) as NodeValue)),
  },
  __Field: {
    name: scalar('String', (p) => (p as { name: string }).name),
  },
  __EnumValue: {
    name: scalar('String', (p) => (p as { name: string }).name),
  },
  CreateIssuePayload: {
    issue: object('Issue', (p) => ({ __type: 'Issue', repo: (p as { repo: Repo }).repo, issue: (p as { issue: Issue }).issue })),
  },
  CloseIssuePayload: {
    issue: object('Issue', (p) => ({ __type: 'Issue', repo: (p as { repo: Repo }).repo, issue: (p as { issue: Issue }).issue })),
  },
  CreatePullRequestPayload: {
    pullRequest: object('PullRequest', (p) => ({ __type: 'PullRequest', repo: (p as { repo: Repo }).repo, pull: (p as { pull: Pull }).pull })),
  },
  MergePullRequestPayload: {
    pullRequest: object('PullRequest', (p) => ({ __type: 'PullRequest', repo: (p as { repo: Repo }).repo, pull: (p as { pull: Pull }).pull })),
  },
  AddCommentPayload: {
    commentEdge: object('IssueCommentEdge', (p) => {
      const v = p as { repo: Repo; issue: Issue; commentIdNumber: number; body: string };
      return { __type: 'IssueCommentEdge', repo: v.repo, issue: v.issue, commentIdNumber: v.commentIdNumber, body: v.body };
    }),
  },
  IssueCommentEdge: {
    node: object('IssueComment', (p) => {
      const v = p as { repo: Repo; issue: Issue; commentIdNumber: number; body: string };
      return { __type: 'IssueComment', repo: v.repo, issue: v.issue, commentIdNumber: v.commentIdNumber, body: v.body };
    }),
    cursor: scalar('String', () => null),
  },
  IssueComment: {
    id: scalar('ID', (p) => {
      const v = p as { repo: Repo; issue: Issue; commentIdNumber: number };
      return commentId(v.repo, v.issue, v.commentIdNumber);
    }),
    body: scalar('String', (p) => (p as { body: string }).body),
  },
};

// The `node` field returns a Node interface; the executor resolves its concrete type from __type.
const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest']);

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface GqlError {
  readonly message: string;
}

interface Executor {
  readonly store: ForgeStore;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: Readonly<Record<string, FragmentDefinitionNode>>;
  readonly errors: GqlError[];
}

function executeSelectionSet(
  exec: Executor,
  parent: NodeValue | null,
  typeName: string,
  selectionSet: SelectionSetNode,
): Record<string, unknown> | null {
  if (parent === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'spread') {
      const fragment = exec.fragments[selection.name];
      if (fragment === undefined) {
        exec.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== typeName && !NODE_TYPES.has(fragment.typeCondition)) continue;
      const sub = executeSelectionSet(exec, parent, typeName, fragment.selectionSet);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    if (selection.kind === 'fragment') {
      const condition = selection.typeCondition;
      if (condition !== null && condition !== typeName) {
        // An inline fragment on another type: skip unless the parent is that type.
        if (!(condition === 'Node' && NODE_TYPES.has(typeName))) continue;
        if (condition !== 'Node') continue;
      }
      const sub = executeSelectionSet(exec, parent, typeName, selection.selectionSet);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    // A field.
    const responseName = selection.alias ?? selection.name;
    const fields = SCHEMA[typeName];
    const def = fields?.[selection.name];
    if (def === undefined) {
      exec.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[responseName] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, valueNode] of Object.entries(selection.args)) {
      args[name] = resolveValue(valueNode, exec.variables);
    }
    let value: unknown;
    try {
      value = def.resolve(parent, args, exec.store);
    } catch (error) {
      exec.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[responseName] = null;
      continue;
    }
    if (selection.selectionSet === null) {
      out[responseName] = value === undefined ? null : value;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseName] = null;
      continue;
    }
    if (def.list === true) {
      const items = value as NodeValue[];
      out[responseName] = items.map((item) => executeSelectionSet(exec, item, def.type, selection.selectionSet as SelectionSetNode));
      continue;
    }
    const node = value as NodeValue;
    const concreteType = node.__type === 'Node' ? typeName : node.__type;
    out[responseName] = executeSelectionSet(exec, node, concreteType, selection.selectionSet);
  }
  return out;
}

export interface GqlResult {
  readonly data: Record<string, unknown> | null;
  readonly errors?: GqlError[];
}

/** Execute one operation document against the store. */
export function executeGraphQL(
  store: ForgeStore,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  operationName?: string,
): GqlResult {
  let parsed;
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = operationName !== undefined
    ? parsed.operations.find((op) => op.name === operationName)
    : parsed.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of Object.entries(operation.variableDefinitions)) {
    if (mergedVariables[name] === undefined && defaultValue !== null) {
      mergedVariables[name] = resolveValue(defaultValue, variables);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: NodeValue = operation.operation === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const exec: Executor = { store, variables: mergedVariables, fragments: parsed.fragments, errors: [] };
  const data = executeSelectionSet(exec, root, rootType, operation.selectionSet);
  const result: GqlResult = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}
