// git.ts — the git smart-HTTP surface: info/refs advertisements, protocol v2 ls-refs
// and fetch, and v0 receive-pack pushes, all over the in-memory object store.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack    v2 caps (Git-Protocol: version=2) or v0 refs
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack   v0 refs + push capabilities
//   POST /{owner}/{repo}.git/git-upload-pack                      v2 commands (ls-refs, fetch); v0 fetch too
//   POST /{owner}/{repo}.git/git-receive-pack                     command list + pack, report-status reply
//
// Fetch object selection follows git's rules: the closure of the wants minus the closure
// of the haves, with shallow boundaries computed by generation distance when a depth is
// requested. Packs are written with full objects only (valid packs; delta compression is
// optional) except shallow-clone packs, which are cached per (tip, depth).

import {
  PKT_FLUSH,
  Store,
  ZERO_OID,
  buildPack,
  decodePackets,
  parseCommit,
  parseTagTarget,
  parseTree,
  pktLine,
  readPack,
  type Repo,
} from './core.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta quiet atomic';

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function peelOf(store: Store, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = store.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTagTarget(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Advertisement and ls-refs replies are pure functions of the ref state:
 *  cache them per refsVersion (bounded, cleared wholesale when full). */
const advCache = new Map<string, GitReply>();
const lsRefsCache = new Map<string, Buffer>();

export function advertise(store: Store, repo: Repo, service: string, version2: boolean): GitReply {
  const cacheKey = `${repo.id}:${repo.refsVersion}:${repo.headRef}:${service}:${version2 ? 2 : 0}`;
  const cachedReply = advCache.get(cacheKey);
  if (cachedReply) return cachedReply;
  const reply = advertiseFresh(store, repo, service, version2);
  if (advCache.size > 256) advCache.clear();
  advCache.set(cacheKey, reply);
  return reply;
}

function advertiseFresh(store: Store, repo: Repo, service: string, version2: boolean): GitReply {
  if (service === 'git-upload-pack' && version2) {
    const lines = [
      'version 2',
      'agent=forge-1.0',
      'ls-refs=unborn',
      'fetch=shallow wait-for-done',
      'server-option',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `${UPLOAD_CAPS_V0} symref=HEAD:${repo.headRef} agent=forge-1.0`
    : `${RECEIVE_CAPS} symref=HEAD:${repo.headRef} agent=forge-1.0`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([name, oid], index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${oid} ${name}${suffix}\n`));
      const peeled = peelOf(store, oid);
      if (peeled !== null && peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

export function lsRefs(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const cacheKey = `${repo.id}:${repo.refsVersion}:${repo.headRef}:${args.peel ? 1 : 0}${args.symrefs ? 1 : 0}:${args.prefixes.join(',')}`;
  const cachedReply = lsRefsCache.get(cacheKey);
  if (cachedReply) return cachedReply;
  const reply = lsRefsFresh(store, repo, args);
  if (lsRefsCache.size > 256) lsRefsCache.clear();
  lsRefsCache.set(cacheKey, reply);
  return reply;
}

function lsRefsFresh(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTarget = repo.headRef;
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelOf(store, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// fetch (protocol v2 and v0)

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

interface FetchPlan {
  send: Set<string>;
  shallowLines: string[];
  unshallowLines: string[];
  commonHave: string | null;
}

/** Decide exactly which objects a fetch sends, and the shallow boundary it reports. */
export function planFetch(store: Store, args: FetchArgs): FetchPlan {
  const clientShallow = new Set(args.shallow);
  // Commits the client already holds: haves and their ancestors, with the client's
  // shallow boundary treated as parentless (that history is not theirs either).
  const haveCommits = new Set<string>();
  {
    const stack = [...args.haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveCommits.has(oid)) continue;
      const view = store.commitOf(oid);
      if (!view) continue;
      haveCommits.add(oid);
      if (clientShallow.has(oid)) continue;
      for (const parent of view.parents) stack.push(parent);
    }
  }
  // Generation distance of every commit from the wants (BFS over parents).
  const dist = new Map<string, number>();
  {
    const queue: [string, number][] = [];
    for (const want of args.wants) {
      const commit = peelToCommitLocal(store, want);
      if (commit !== null && !dist.has(commit)) {
        dist.set(commit, 0);
        queue.push([commit, 0]);
      }
    }
    let queueHead = 0;
    while (queueHead < queue.length) {
      const [oid, depth] = queue[queueHead++]!;
      const view = store.commitOf(oid);
      if (!view) continue;
      for (const parent of view.parents) {
        if (!dist.has(parent)) {
          dist.set(parent, depth + 1);
          queue.push([parent, depth + 1]);
        }
      }
    }
  }
  const depth = args.depth;
  const sentCommits = new Set<string>();
  for (const [oid, d] of dist) {
    if (depth !== null) {
      if (d < depth) sentCommits.add(oid);
    } else if (!haveCommits.has(oid)) {
      sentCommits.add(oid);
    }
  }
  // Object-level exclusion: everything reachable from the commits the client
  // already holds (its shallow boundary treated as parentless) stays on the
  // client. Commits beyond a depth cut are NOT excluded — their objects are
  // still sent whenever a sent commit's tree reaches them (shared blobs).
  // The exclusion closure is bounded by the client's shallow list: a commit the
  // client holds shallowly does not put its ancestors (or their trees) on the
  // client, so those objects are never excluded.
  const excluded = new Set<string>();
  {
    const stack = [...haveCommits];
    const seenCommits = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      const object = store.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        excluded.add(oid);
        const view = store.commitOf(oid)!;
        for (const entry of store.reachable([view.tree])) excluded.add(entry);
        if (clientShallow.has(oid)) continue;
        for (const parent of view.parents) stack.push(parent);
      } else {
        for (const entry of store.reachable([oid])) excluded.add(entry);
      }
    }
  }
  // The send set: every sent commit plus its full tree closure, plus any
  // non-commit want (a tag object rides along and points at its commit).
  // Parent commits outside the sent set are never walked into.
  const send = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (send.has(oid)) continue;
      const object = store.objects.get(oid);
      if (!object) continue;
      send.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTreeEntries(store, oid)) stack.push(entry);
      }
    }
  };
  const addCommit = (oid: string): void => {
    if (!sentCommits.has(oid)) return;
    if (send.has(oid)) return;
    const view = store.commitOf(oid);
    if (!view) return;
    send.add(oid);
    addTreeClosure(view.tree);
  };
  for (const oid of sentCommits) addCommit(oid);
  for (const want of args.wants) {
    const object = store.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      send.add(want);
      const target = parseTagTarget(object.data).object;
      const targetObject = store.objects.get(target);
      if (targetObject?.type === 'commit') addCommit(target);
      else if (targetObject) send.add(target);
    } else if (object.type === 'commit') {
      addCommit(want);
    } else {
      send.add(want);
    }
  }
  for (const oid of excluded) send.delete(oid);
  // A want the client named explicitly always rides along.
  for (const want of args.wants) {
    if (store.objects.has(want) && !haveCommits.has(want)) send.add(want);
  }
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (depth !== null) {
    for (const oid of sentCommits) {
      const view = store.commitOf(oid);
      if (!view) continue;
      const cut = view.parents.some((parent) => !sentCommits.has(parent));
      if (cut) shallowLines.push(oid);
      else if (clientShallow.has(oid)) unshallowLines.push(oid);
    }
  }
  let commonHave: string | null = null;
  for (const have of args.haves) {
    if (store.objects.has(have)) {
      commonHave = have;
      break;
    }
  }
  return { send, shallowLines, unshallowLines, commonHave };
}

function parseTreeEntries(store: Store, treeOid: string): string[] {
  return store.treeOf(treeOid).map((entry) => entry.oid);
}

function peelToCommitLocal(store: Store, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = store.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTagTarget(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32_768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

export function fetchV2(store: Store, repo: Repo, args: FetchArgs): GitReply {
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.commonHave !== null && args.haves.length > 0) {
    parts.push(pktLine(`ACK ${plan.commonHave}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (plan.send.size > 0) {
    parts.push(pktLine('packfile\n'));
    let pack: Buffer;
    if (args.depth === 1 && args.wants.length === 1) {
      const key = `${args.wants[0]}:1`;
      const cached = repo.packCache.get(key);
      if (cached !== undefined) pack = cached;
      else {
        pack = buildPack(store, plan.send);
        if (repo.packCache.size > 64) repo.packCache.clear();
        repo.packCache.set(key, pack);
      }
    } else {
      pack = buildPack(store, plan.send);
    }
    parts.push(...sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function fetchV0(store: Store, repo: Repo, args: FetchArgs): GitReply {
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  if (plan.send.size > 0) {
    parts.push(...sidebandPack(buildPack(store, plan.send)));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** Parse a v2 command request body into (command, argument lines). */
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePackets(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  return { command, args };
}

export function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

export function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** Parse a v0 upload-pack request (two pkt-line sections: wants, then haves/done). */
export function parseV0Fetch(body: Buffer): FetchArgs {
  const packets = decodePackets(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// receive-pack (v0)

export interface PushOutcome {
  status: number;
  body: Buffer;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

export function receivePack(store: Store, repo: Repo, body: Buffer): PushOutcome {
  // Split the command list (pkt-lines up to the first flush) from the pack that follows.
  let pos = 0;
  const commands: PushCommand[] = [];
  let packStart = -1;
  while (pos + 4 <= body.length) {
    const head = body.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packStart = pos + 4;
      break;
    }
    if (length < 4 || pos + length > body.length) break;
    let line = body.toString('utf8', pos + 4, pos + length).replace(/\n$/, '');
    let caps = '';
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]!, caps });
    }
    pos += length;
  }
  const wantSideband = commands.length > 0 && commands[0]!.caps.includes('side-band-64k');
  const wantReport = commands.length > 0 && (commands[0]!.caps.includes('report-status'));
  const hasPack = packStart !== -1 && packStart < body.length;
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjects = new Map<string, string>();
  if (hasPack) {
    try {
      const entries = readPack(store, body.subarray(packStart));
      for (const entry of entries) {
        if (!store.objects.has(entry.oid)) {
          store.objects.set(entry.oid, { type: entry.type, data: entry.data });
          newObjects.set(entry.oid, entry.type);
        }
      }
    } catch {
      unpackOk = false;
      unpackDetail = 'unparseable pack';
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok');
  else reportLines.push(`unpack ${unpackDetail}`);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const verdict = applyCommand(store, repo, command);
    reportLines.push(verdict === null ? `ok ${command.ref}` : `ng ${command.ref} ${verdict}`);
  }
  if (!wantReport) {
    return { status: 200, body: Buffer.alloc(0) };
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  if (wantSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 32_768;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, body: Buffer.concat(parts) };
  }
  return { status: 200, body: report };
}

/** Apply one ref update; returns the refusal reason or null when it applied. */
function applyCommand(store: Store, repo: Repo, command: PushCommand): string | null {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (current !== oldOid) return 'reference was changed in the meantime';
  if (newOid === ZERO_OID) {
    store.deleteRef(repo, ref);
    return null;
  }
  const target = store.objects.get(newOid);
  if (!target) return 'missing object';
  if (oldOid !== ZERO_OID) {
    // Updates must fast-forward: the old tip must be an ancestor of the new one.
    const oldCommit = peelToCommitLocal(store, oldOid);
    const newCommit = peelToCommitLocal(store, newOid);
    if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit) {
      if (!store.isAncestor(oldCommit, newCommit)) return 'non-fast-forward';
    }
  }
  store.setRef(repo, ref, newOid);
  return null;
}
