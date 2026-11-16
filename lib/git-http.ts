// Smart HTTP git endpoints: info/refs advertisements (v0 + v2), upload-pack fetch (v0 + v2),
// receive-pack push (v0). The wire format follows program/env/src/git-client.ts exactly —
// that file is the ground truth for what the suite sends and parses.
//
// Version selection: info/refs for upload-pack with `Git-Protocol: version=2` answers v2,
// otherwise v0; receive-pack is v0-only. Unknown repository -> 404 on every git route.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  readPack,
  type GitObject,
} from './gitobj.ts';
import { ForgeStore, type Repo } from './store.ts';

export const AGENT = 'github-core-clone-01/1.0.0';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(message: string): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** Split a pack into sideband band-1 packets (band byte 1 + chunk, each a pkt-line). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // one band byte + this chunk must fit in PKT_LINE_MAX_PAYLOAD (65516)
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) {
    // A 0-object pack is still 32 bytes, so this is unreachable; keep the guard for safety.
    out.push(encodePktLine(Buffer.from([1])));
  }
  return out;
}

/** All refs of a repo, sorted, as [refname, oid] pairs (HEAD first for the advertisement). */
function sortedRefs(repo: Repo): Array<[string, string]> {
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return refs;
}

/** The peeled oid of an annotated tag ref, or undefined when the ref is not an annotated tag. */
function peeledOf(store: ForgeStore, oid: string): string | undefined {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  const text = object.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? undefined : match[1];
}

const UPLOAD_V0_CAPS = [
  'multi_ack',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'deepen-relative',
  'no-progress',
  'include-tag',
  'multi_ack_detailed',
  'allow-tip-sha1-in-want',
  'allow-reachable-sha1-in-want',
  'no-done',
  'filter',
  'object-format=sha1',
  `agent=${AGENT}`,
];

const RECEIVE_V0_CAPS = [
  'report-status',
  'report-status-v2',
  'delete-refs',
  'side-band-64k',
  'ofs-delta',
  'thin-pack',
  `agent=${AGENT}`,
];

/** Build a v0 advertisement body (with the # service= header line). */
function v0Advertisement(store: ForgeStore, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? ZERO_OID;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const capList = [`symref=HEAD:${headRef}`, ...caps].join(' ');
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${capList}\n`);
  } else {
    lines.push(`${headOid} HEAD\0${capList}\n`);
    for (const [ref, oid] of sortedRefs(repo)) {
      lines.push(`${oid} ${ref}\n`);
      const peeled = peeledOf(store, oid);
      if (peeled !== undefined) lines.push(`${peeled} ${ref}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** Build a v2 upload-pack advertisement body (no service header line). */
function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

interface FetchPlan {
  readonly wants: string[];
  readonly haves: string[];
  readonly depth?: number;
  readonly clientShallow: string[];
}

/** Parse a v2 ls-refs request body into its options. */
function parseV2LsRefsRequest(body: Buffer): { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] } | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  let command = '';
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (line.startsWith('command=')) {
      command = line.slice('command='.length).trim();
      continue;
    }
    if (line === 'peel\n') peel = true;
    else if (line === 'symrefs\n') symrefs = true;
    else if (line === 'unborn\n') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
  }
  if (command !== 'ls-refs') return null;
  return { peel, symrefs, unborn, prefixes };
}

/** Build a v2 ls-refs response body. */
function v2LsRefsResponse(store: ForgeStore, repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (keep('HEAD')) {
    if (headOid !== undefined && headOid !== ZERO_OID) {
      lines.push(`${headOid} HEAD${opts.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (opts.unborn) {
      lines.push(`unborn HEAD${opts.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (opts.peel) {
      const peeled = peeledOf(store, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** Parse a v2 fetch request body into its wants/haves/depth/client-shallow set. */
function parseV2FetchRequest(body: Buffer): FetchPlan | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let command = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (line.startsWith('command=')) {
      command = line.slice('command='.length).trim();
      continue;
    }
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(n) && n >= 0) depth = n;
    }
  }
  if (command !== 'fetch') return null;
  if (wants.some((w) => !isObjectId(w)) || haves.some((h) => !isObjectId(h))) return null;
  return { wants, haves, depth, clientShallow };
}

/** Parse a v0 fetch request body (two sections split by a flush) into a FetchPlan. */
function parseV0FetchRequest(body: Buffer): FetchPlan | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).trim();
        const oid = rest.split(' ')[0] as string;
        wants.push(oid);
      } else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isInteger(n) && n >= 0) depth = n;
      }
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  if (wants.length === 0) return null;
  if (wants.some((w) => !isObjectId(w)) || haves.some((h) => !isObjectId(h))) return null;
  return { wants, haves, depth, clientShallow };
}

/** The pack + boundary answer for a fetch plan, shared by the v0 and v2 responders. */
function planFetch(store: ForgeStore, repo: Repo, plan: FetchPlan): { pack: Buffer; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean; wantedRefs: Array<{ oid: string; ref: string }> } {
  const { pack, shallow } = store.packFor(repo, plan.wants, plan.haves, plan.depth, plan.clientShallow);
  const shallowSet = new Set(shallow);
  const unshallow = plan.clientShallow.filter((oid) => !shallowSet.has(oid));
  const acks: string[] = [];
  for (const have of plan.haves) {
    if (store.getObject(have) !== undefined) acks.push(have);
  }
  const nak = acks.length === 0;
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const want of plan.wants) {
    for (const [ref, oid] of repo.refs.entries()) {
      if (oid === want) wantedRefs.push({ oid, ref });
    }
  }
  return { pack, shallow, unshallow, acks, nak, wantedRefs };
}

/** Build a v2 fetch response body. */
function v2FetchResponse(answer: ReturnType<typeof planFetch>, depthRequested: boolean): Buffer {
  const parts: Buffer[] = [];
  const lines: Array<string | 'delim' | 'flush'> = [];
  lines.push('acknowledgments\n');
  if (answer.nak) lines.push('NAK\n');
  else for (const ack of answer.acks) lines.push(`ACK ${ack}\n`);
  lines.push('ready\n');
  lines.push('delim');
  if (depthRequested || answer.shallow.length > 0 || answer.unshallow.length > 0) {
    lines.push('shallow-info\n');
    for (const oid of answer.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of answer.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
  }
  if (answer.wantedRefs.length > 0) {
    lines.push('wanted-refs\n');
    for (const { oid, ref } of answer.wantedRefs) lines.push(`${oid} ${ref}\n`);
    lines.push('delim');
  }
  lines.push('packfile\n');
  parts.push(encodePktLines(lines));
  for (const packet of sidebandPack(answer.pack)) parts.push(packet);
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

/** Build a v0 fetch response body (plain ACK/NAK/shallow lines, then the sideband pack). */
function v0FetchResponse(answer: ReturnType<typeof planFetch>): Buffer {
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (answer.nak) lines.push('NAK\n');
  else for (const ack of answer.acks) lines.push(`ACK ${ack}\n`);
  for (const oid of answer.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of answer.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  for (const packet of sidebandPack(answer.pack)) parts.push(packet);
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
  readonly capabilities: string[];
}

/** Parse a receive-pack request body: the command list, then the raw pack bytes. */
function parsePushRequest(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  // Find the end of the command list: the first flush packet.
  let offset = 0;
  const commands: PushCommand[] = [];
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    const lenHex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) return null;
    const len = Number.parseInt(lenHex, 16);
    if (len === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (len < 4 || offset + len > body.length) return null;
    const payload = body.subarray(offset + 4, offset + len);
    const text = payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul < 0 ? text : text.slice(0, nul);
    const caps = nul < 0 ? [] : text.slice(nul + 1).split(' ').filter(Boolean);
    const parts = head.trim().split(' ');
    if (parts.length < 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref, capabilities: caps });
    offset += len;
  }
  if (!sawFlush || commands.length === 0) return null;
  return { commands, pack: body.subarray(offset) };
}

/** Apply a push: ingest the pack, validate each command, update refs, build the report. */
function applyPush(store: ForgeStore, repo: Repo, commands: PushCommand[], pack: Buffer): { reportLines: string[]; unpackOk: boolean } {
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  let objects: Map<string, GitObject> | null = null;
  if (hasUpdates) {
    if (pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error: missing pack';
    } else {
      try {
        objects = readPack(pack);
      } catch (error) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${error instanceof Error ? error.message : 'bad pack'}`;
      }
    }
  }
  if (objects !== null) store.putObjects(objects.values());
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: unpackDetail });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        store.touch(repo);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = store.getObject(command.newOid);
    if (target === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        store.touch(repo);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: the ref must be at oldOid and newOid must descend from oldOid.
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (command.newOid === command.oldOid) {
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else if (!store.isAncestor(command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      store.touch(repo);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  const lines = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  return { reportLines: lines, unpackOk };
}

/** Build a receive-pack response: the report pkt-lined, inside sideband band 1 when requested. */
function pushResponse(reportLines: string[], useSideband: boolean): Buffer {
  const inner = encodePktLines([...reportLines, 'flush' as const]);
  if (!useSideband) return inner;
  const parts: Buffer[] = [];
  const CHUNK = 65515; // one band byte + this chunk must fit in PKT_LINE_MAX_PAYLOAD (65516)
  for (let i = 0; i < inner.length; i += CHUNK) {
    const chunk = inner.subarray(i, Math.min(inner.length, i + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// router entry point
// -------------------------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git route (the caller
 * falls through to the REST/GraphQL/MCP router). `pathname` is the decoded URL path, `query` the
 * parsed query string, `headers` the lower-cased request headers, `body` the raw request body.
 */
export function handleGit(
  store: ForgeStore,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitResponse | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return null;
  const [, owner, repoName, route] = match as [string, string, string, string];
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound(`repository ${owner}/${repoName} not found`);

  if (route === 'info/refs' && method === 'GET') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return badRequest('missing or unknown service');
    }
    const wantsV2 = service === 'git-upload-pack' && (headers['git-protocol'] ?? '').includes('version=2');
    const contentType = service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
    return ok(contentType, wantsV2 ? v2Advertisement() : v0Advertisement(store, repo, service));
  }

  if (route === 'git-upload-pack' && method === 'POST') {
    const isV2 = (headers['git-protocol'] ?? '').includes('version=2');
    if (isV2) {
      // A v2 upload-pack request is either ls-refs or fetch; tell them apart by the command.
      const lsRefs = parseV2LsRefsRequest(body);
      if (lsRefs !== null) {
        return ok('application/x-git-upload-pack-result', v2LsRefsResponse(store, repo, lsRefs));
      }
      const plan = parseV2FetchRequest(body);
      if (plan === null) return badRequest('malformed upload-pack request');
      const answer = planFetch(store, repo, plan);
      return ok('application/x-git-upload-pack-result', v2FetchResponse(answer, plan.depth !== undefined));
    }
    const plan = parseV0FetchRequest(body);
    if (plan === null) return badRequest('malformed upload-pack request');
    const answer = planFetch(store, repo, plan);
    return ok('application/x-git-upload-pack-result', v0FetchResponse(answer));
  }

  if (route === 'git-receive-pack' && method === 'POST') {
    const parsed = parsePushRequest(body);
    if (parsed === null) return badRequest('malformed receive-pack request');
    const useSideband = parsed.commands[0]?.capabilities.includes('side-band-64k') ?? false;
    const { reportLines } = applyPush(store, repo, parsed.commands, parsed.pack);
    return ok('application/x-git-receive-pack-result', pushResponse(reportLines, useSideband));
  }

  return { status: 405, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Method Not Allowed' }), 'utf8') };
}
