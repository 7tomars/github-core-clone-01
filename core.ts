// core.ts — the forge's heart: an in-memory store (repositories, issues, pull requests,
// labels, comments) plus a complete git object engine (SHA-1 objects, trees, commits,
// packfiles, pkt-lines) built on node:crypto and node:zlib alone.
//
// Everything lives in memory: a trial starts from an empty forge and the suite builds
// every fixture through the public surfaces, so no persistence is needed and reads stay
// fast. All timestamps come from a logical clock seeded by MAKEFUN_TRIAL_NOW, never from
// the wall clock, so two runs of the same request sequence produce the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------
// parsed views

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('utf8', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function parseTagTarget(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

/** Peel any object to the commit it ultimately names (tag -> target, commit -> itself). */
export function peelToCommit(store: Store, oid: string): string | null {
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

// ---------------------------------------------------------------------------
// domain model

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  isPull: false;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  isPull: true;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  priv: boolean;
  createdAt: string;
  refs: Map<string, string>;
  headRef: string;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  /** cached packfile bytes for shallow clones, keyed by tip oid */
  packCache: Map<string, Buffer>;
}

export class Store {
  objects = new Map<string, { type: ObjType; data: Buffer }>();
  repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  private nextRepoId = 1;
  private nextCommentId = 1;
  private clockSec: number;
  private clockTick = 0;

  constructor() {
    let base = 1_735_689_600; // 2025-01-01T00:00:00Z
    const nowEnv = process.env.MAKEFUN_TRIAL_NOW ?? '';
    if (nowEnv !== '') {
      const parsed = Date.parse(nowEnv);
      if (!Number.isNaN(parsed)) base = Math.floor(parsed / 1000);
      else if (/^\d+$/.test(nowEnv)) base = Number.parseInt(nowEnv, 10);
    }
    this.clockSec = base;
  }

  /** Deterministic, strictly increasing timestamps (ISO strings). */
  nowIso(): string {
    this.clockTick += 1;
    return new Date((this.clockSec + this.clockTick) * 1000).toISOString();
  }

  nowEpoch(): number {
    this.clockTick += 1;
    return this.clockSec + this.clockTick;
  }

  learnViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  createRepo(name: string, description: string, priv: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      description,
      priv,
      createdAt: this.nowIso(),
      refs: new Map(),
      headRef: 'refs/heads/main',
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      packCache: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  nextComment(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  hashOfBlob(data: Buffer): string {
    return hashObject('blob', data);
  }

  /** Store a commit built from a flat path->bytes map on top of a parent (or none). */
  commitFiles(
    parentOid: string | null,
    files: Map<string, Buffer>,
    message: string,
    authorLine: string,
  ): string {
    const tree = this.treeFromFiles(files);
    const lines = [`tree ${tree}`];
    if (parentOid !== null) lines.push(`parent ${parentOid}`);
    lines.push(`author ${authorLine}`);
    lines.push(`committer ${authorLine}`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
    return this.putObject('commit', data);
  }

  treeFromFiles(files: Map<string, Buffer>): string {
    interface Node {
      files: Map<string, Buffer>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, data] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i]!;
        if (!node.dirs.has(segment)) node.dirs.set(segment, make());
        node = node.dirs.get(segment)!;
      }
      node.files.set(segments[segments.length - 1]!, data);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: this.putObject('blob', data) });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The flat path->blob-oid map of a commit's tree (recursive). */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') this.flattenTree(entry.oid, `${prefix}${entry.name}/`, out);
      else out.set(`${prefix}${entry.name}`, entry.oid);
    }
    return out;
  }

  filesOfCommit(commitOid: string): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return files;
    const flat = this.flattenTree(parseCommit(commit.data).tree);
    for (const [path, oid] of flat) {
      const blob = this.objects.get(oid);
      if (blob) files.set(path, blob.data);
    }
    return files;
  }

  /** All objects reachable from a set of root oids (commits walk parents, tags peel). */
  reachable(roots: Iterable<string>, stopAt?: Set<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      if (stopAt !== undefined && stopAt.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTagTarget(object.data).object);
      }
    }
    return seen;
  }

  /** Commit ancestors of a tip (inclusive), following first-and-all parents. */
  commitAncestors(tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(ancestor: string, tip: string): boolean {
    return this.commitAncestors(tip).has(ancestor);
  }

  /** A merge base of two commits (first common ancestor in BFS order from b). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = this.commitAncestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a full pkt-line stream; throws on malformed input. */
export function decodePackets(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
    } else {
      if (length < 4 || pos + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: bytes.subarray(pos + 4, pos + length) });
      pos += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------------------
// packfiles

function writePackHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (TYPE_IDS[type]! << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** Build a complete packfile (version 2, full objects, no deltas) with trailer. */
export function buildPack(store: Store, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const object = store.objects.get(oid);
    if (!object) continue;
    parts.push(writePackHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; typeId: number } {
  let pos = start;
  const first = buffer[pos]!;
  pos += 1;
  const typeId = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let byte = first;
  while (byte & 0x80) {
    byte = buffer[pos]!;
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next: pos, typeId };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return size;
  };
  readSize(); // base size
  const targetSize = readSize();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          length |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (length === 0) length = 0x10000;
      out.push(base.subarray(offset, offset + length));
      produced += length;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta size mismatch');
  return result;
}

export interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/**
 * Parse a packfile into resolved objects. Bases for ref-deltas (and thin-pack ofs bases)
 * are looked up in the store when they are not in the pack itself.
 */
export function readPack(store: Store, pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  interface Raw {
    offset: number;
    type: ObjType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw & { resolved?: PackEntry }>();
  for (let i = 0; i < count; i += 1) {
    const offset = pos;
    const head = readVarintSize(pack, pos);
    pos = head.next;
    let raw: Raw;
    if (head.typeId === 6) {
      let byte = pack[pos]!;
      pos += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos]!;
        pos += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const inflated = inflateSync(pack.subarray(pos));
      raw = { offset, type: 'ofs-delta', data: inflated, baseOffset: offset - baseOffset };
      pos += compressedLength(pack, pos, inflated.length);
    } else if (head.typeId === 7) {
      const baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const inflated = inflateSync(pack.subarray(pos));
      raw = { offset, type: 'ref-delta', data: inflated, baseOid };
      pos += compressedLength(pack, pos, inflated.length);
    } else {
      const type = ID_TYPES[head.typeId];
      if (!type) throw new Error(`unknown pack object type ${head.typeId}`);
      const inflated = inflateSync(pack.subarray(pos));
      raw = { offset, type, data: inflated };
      pos += compressedLength(pack, pos, inflated.length);
    }
    raws.push(raw);
    byOffset.set(offset, raw);
  }
  const resolve = (raw: Raw): PackEntry => {
    const memo = raw as Raw & { resolved?: PackEntry };
    if (memo.resolved) return memo.resolved;
    let entry: PackEntry;
    if (raw.type === 'ofs-delta') {
      const baseRaw = byOffset.get(raw.baseOffset!);
      if (!baseRaw) throw new Error('ofs-delta base missing from pack');
      const base = resolve(baseRaw);
      const data = applyDelta(base.data, raw.data);
      entry = { oid: hashObject(base.type, data), type: base.type, data };
    } else if (raw.type === 'ref-delta') {
      let baseEntry: PackEntry | undefined;
      const inPack = raws.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === raw.baseOid);
      if (inPack) baseEntry = resolve(inPack);
      else {
        const stored = store.objects.get(raw.baseOid!);
        if (!stored) throw new Error('ref-delta base missing');
        baseEntry = { oid: raw.baseOid!, type: stored.type, data: stored.data };
      }
      const data = applyDelta(baseEntry.data, raw.data);
      entry = { oid: hashObject(baseEntry.type, data), type: baseEntry.type, data };
    } else {
      entry = { oid: hashObject(raw.type, raw.data), type: raw.type, data: raw.data };
    }
    memo.resolved = entry;
    return entry;
  };
  return raws.map(resolve);
}

/** The compressed length of the zlib stream starting at `start` (found by inflating). */
function compressedLength(pack: Buffer, start: number, expectedPlain: number): number {
  // inflateSync consumes a whole buffer; find the stream end by trying the trailer:
  // zlib streams are self-terminating, and Node reports bytes read only via streaming API.
  // The pack sizes here are small, so binary-search the shortest prefix that inflates.
  let lo = 1;
  let hi = pack.length - start;
  const ok = (length: number): boolean => {
    try {
      return inflateSync(pack.subarray(start, start + length)).length === expectedPlain;
    } catch {
      return false;
    }
  };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
