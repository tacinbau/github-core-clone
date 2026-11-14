// A standalone, GitHub-compatible git forge: git smart HTTP (upload-pack v2, receive-pack v0),
// REST v3, GraphQL v4 and MCP, all in one process over Node 22's standard library only.
// No git binary, no package manager, no outside service: the pack protocol, the object store and
// every API surface are implemented here, in memory.
//
// Determinism: nothing in any reply reads the wall clock or an unseeded random source. Every
// timestamp derives from MAKEFUN_TRIAL_NOW (the instance's opening time, the same on a replay)
// plus a monotonic sequence, every id from a counter, every global id from a stable encoding.
// Two runs on one instance therefore answer byte-identically for the same requests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// Identity and time
// ---------------------------------------------------------------------------------------------

/** The login the trial bearer token names (the kit's scenario seed is constant, so this is fixed). */
const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
const VIEWER_LOGIN = VIEWER.login;
/** The default branch every repository is created with (the scenario's repos use it too). */
const DEFAULT_BRANCH = 'main';
const ZERO_OID = '0'.repeat(40);
const SHA40 = /^[0-9a-f]{40}$/i;

/** The instance's opening time: the only "now" any reply may carry. */
function trialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^-?\d+$/.test(raw)) {
      const ms = Number(raw);
      if (Number.isFinite(ms)) return raw.length > 13 ? Math.floor(ms / 1000) * 1000 : ms;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse('2026-11-14T06:30:00.000Z');
}
const TRIAL_NOW_MS = trialNowMs();
const TRIAL_EPOCH_SEC = Math.floor(TRIAL_NOW_MS / 1000);

/** Monotonic sequence: orders creations and stamps them, deterministically. */
let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}
/** ISO timestamp for sequence `s` (one second apart, from the trial's opening time). */
function isoAt(s: number): string {
  return new Date(TRIAL_NOW_MS + s * 1000).toISOString();
}
/** Unix seconds for sequence `s`. */
function epochAt(s: number): number {
  return TRIAL_EPOCH_SEC + s;
}
/** The author/committer identity line for REST-created commits. */
function identLine(s: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${epochAt(s)} +0000`;
}

let reqSeq = 0;
function nextRequestId(): string {
  reqSeq += 1;
  return `req-${reqSeq}`;
}

// ---------------------------------------------------------------------------------------------
// Git primitives: objects, pkt-lines, packs
// ---------------------------------------------------------------------------------------------

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function isObjectId(value: string): boolean {
  return SHA40.test(value);
}

function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(fields: { tree: string; parents?: readonly string[]; message: string; author: string; committer: string }): Buffer {
  const msg = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  let text = `tree ${fields.tree}\n`;
  for (const parent of fields.parents ?? []) text += `parent ${parent}\n`;
  text += `author ${fields.author}\ncommitter ${fields.committer}\n\n${msg}`;
  return Buffer.from(text, 'utf8');
}

function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** All objects reachable from `tips` (commits, trees, blobs, tags), following commit parents. */
function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { stopAt?: ReadonlySet<string>; depth?: number } = {},
): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 0 });
  while (queue.length > 0) {
    const { oid, depth } = queue.pop()!;
    if (found.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    found.set(oid, object);
    if (options.depth !== undefined && depth >= options.depth) continue;
    if (options.stopAt !== undefined && options.stopAt.has(oid)) continue;
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      for (const parent of view.parents) queue.push({ oid: parent, depth: depth + 1 });
      queue.push({ oid: view.tree, depth: depth + 1 });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push({ oid: entry.oid, depth: depth + 1 });
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, depth: depth + 1 });
    }
  }
  return found;
}

/** The commit oids reachable from `tips`, with their generation depth (0 = the tip itself). */
function commitDepths(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  maxDepth?: number,
): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 0 });
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (depths.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    depths.set(oid, depth);
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return depths;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
function isAncestor(ancestor: string, tip: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The merge-base of two commits: the common ancestor of greatest depth (first found by BFS). */
function mergeBase(a: string, b: string, lookup: (oid: string) => GitObject | undefined): string | null {
  const depthsA = commitDepths([a], lookup);
  if (depthsA.has(b)) return b;
  const queue = [b];
  const seen = new Set<string>();
  let best: string | null = null;
  let bestDepth = -1;
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const depth = depthsA.get(oid);
    if (depth !== undefined && depth > bestDepth) {
      best = oid;
      bestDepth = depth;
    }
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return best;
}

// --- pkt-lines --------------------------------------------------------------------------------

const PKT_LINE_MAX_PAYLOAD = 65516;

function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole pkt-line stream; throws on malformed framing. */
function decodePktLines(bytes: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('pkt-line header truncated');
    const sizeText = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(sizeText)) throw new Error('not a pkt-line');
    const size = parseInt(sizeText, 16);
    if (size === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (size === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (size === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + size > bytes.length) throw new Error('pkt-line truncated');
      packets.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset + 4, offset + size)) });
      offset += size;
    }
  }
  return packets;
}

// --- packs ------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA entries. Throws on corruption. */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolvedCache = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolvedCache.get(entry.offset);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    const out = { type, data, oid };
    resolvedCache.set(entry.offset, out);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), deterministically ordered by oid. */
function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].map((o) => ({ oid: hashObject(o.type, o.data), type: o.type, data: o.data }));
  list.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split pack bytes into sideband band-1 pkt-lines (each pkt-line payload is one band byte + data). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  closedSeq: number | null;
  comments: Comment[];
}

interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
  createdSeq: number;
  closedSeq: number | null;
  mergedSeq: number | null;
  mergeSha: string | null;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  /** Per-repo commit sequence, for newest-first commit listings. */
  commitSeq: Map<string, number>;
}

const repos = new Map<string, Repo>();
let nextDbId = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const s = nextSeq();
  const repo: Repo = {
    id: nextDbId,
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    createdSeq: s,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    commitSeq: new Map(),
  };
  nextDbId += 1;
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function lookupObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Create a commit object in `repo` and record its sequence. */
function createCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const s = nextSeq();
  const line = identLine(s);
  const data = buildCommit({ tree, parents, message, author: line, committer: line });
  const oid = putObject(repo, 'commit', data);
  if (!repo.commitSeq.has(oid)) repo.commitSeq.set(oid, s);
  return oid;
}

/** The tree oid at a ref (branch name, full ref, or commit oid), or null. */
function refTargetTree(repo: Repo, ref: string): string | null {
  let oid: string | undefined;
  if (ref.startsWith('refs/')) oid = repo.refs.get(ref);
  else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`);
  else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`);
  else if (isObjectId(ref)) oid = ref;
  else return null;
  if (oid === undefined) return null;
  const object = lookupObject(repo, oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return parseCommit(object.data).tree;
  if (object.type === 'tag') {
    const target = lookupObject(repo, parseTag(object.data).object);
    if (target !== undefined && target.type === 'commit') return parseCommit(target.data).tree;
    return null;
  }
  return null;
}

/** Resolve a ref-ish to a commit oid (branch, full ref, tag, or oid). */
function resolveRefToCommit(repo: Repo, ref: string): string | null {
  let oid: string | undefined;
  if (ref.startsWith('refs/')) oid = repo.refs.get(ref);
  else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`);
  else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`);
  else if (isObjectId(ref)) oid = ref;
  else return null;
  if (oid === undefined) return null;
  const object = lookupObject(repo, oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    const target = parseTag(object.data).object;
    const targetObject = lookupObject(repo, target);
    return targetObject !== undefined && targetObject.type === 'commit' ? target : null;
  }
  return null;
}

/** Peel a ref to its commit (annotated tags peel to their target commit). */
function peelToCommit(repo: Repo, oid: string): string | null {
  const object = lookupObject(repo, oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    const target = parseTag(object.data).object;
    const targetObject = lookupObject(repo, target);
    return targetObject !== undefined && targetObject.type === 'commit' ? target : null;
  }
  return null;
}

// --- trees ------------------------------------------------------------------------------------

function emptyTreeOid(repo: Repo): string {
  return putObject(repo, 'tree', buildTree([]));
}

/** Read the blob oid at `path` in the tree `rootOid` (null when absent). */
function blobAtPath(repo: Repo, rootOid: string | null, path: string): string | null {
  if (rootOid === null) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let current = rootOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = lookupObject(repo, current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    current = entry.oid;
  }
  return null;
}

/** Set (or delete, when `blobOid` is null) one path in a tree, returning the new root tree oid. */
function setPathInTree(repo: Repo, rootOid: string | null, segments: readonly string[], blobOid: string | null): string {
  const base = rootOid === null ? [] : parseTree(lookupObject(repo, rootOid)?.data ?? Buffer.alloc(0));
  const name = segments[0];
  const rest = segments.slice(1);
  const entries: TreeEntry[] = [];
  let handled = false;
  for (const entry of base) {
    if (entry.name !== name) {
      entries.push(entry);
      continue;
    }
    handled = true;
    if (rest.length === 0) {
      if (blobOid !== null) entries.push({ mode: '100644', name, oid: blobOid });
      // else: delete the entry
    } else {
      if (entry.mode !== '40000') {
        if (blobOid !== null) {
          const child = setPathInTree(repo, null, rest, blobOid);
          entries.push({ mode: '40000', name, oid: child });
        }
      } else {
        const child = setPathInTree(repo, entry.oid, rest, blobOid);
        const childObject = lookupObject(repo, child);
        if (childObject !== undefined && parseTree(childObject.data).length > 0) entries.push({ mode: '40000', name, oid: child });
      }
    }
  }
  if (!handled && blobOid !== null) {
    if (rest.length === 0) {
      entries.push({ mode: '100644', name, oid: blobOid });
    } else {
      const child = setPathInTree(repo, null, rest, blobOid);
      entries.push({ mode: '40000', name, oid: child });
    }
  }
  return putObject(repo, 'tree', buildTree(entries));
}

/** Flatten a tree into path -> {oid, mode} (files only). */
function flattenTree(repo: Repo, rootOid: string | null, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (rootOid === null) return out;
  const object = lookupObject(repo, rootOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, v] of flattenTree(repo, entry.oid, path)) out.set(p, v);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Count differing lines between two texts (prefix/suffix trim, then the rest). */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

/** Diff two trees into a pull-request file list. */
function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) {
      const data = lookupObject(repo, h.oid)?.data ?? Buffer.alloc(0);
      const lines = data.length === 0 ? 0 : data.toString('utf8').split('\n').length;
      files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b !== undefined && h === undefined) {
      const data = lookupObject(repo, b.oid)?.data ?? Buffer.alloc(0);
      const lines = data.length === 0 ? 0 : data.toString('utf8').split('\n').length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = lookupObject(repo, b.oid)?.data.toString('utf8') ?? '';
      const newText = lookupObject(repo, h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiffCounts(oldText, newText);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** Whether merging `headTip` into `baseTip` conflicts (same file changed both sides, differently). */
function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(baseTip, headTip, (oid) => lookupObject(repo, oid));
  if (base === null) return false;
  const baseTree = refTargetTree(repo, base);
  const headTree = refTargetTree(repo, headTip);
  const defaultTree = refTargetTree(repo, baseTip);
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const defaultFiles = flattenTree(repo, defaultTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...defaultFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const d = defaultFiles.get(path)?.oid ?? null;
    const headChanged = h !== b;
    const baseChanged = d !== b;
    if (headChanged && baseChanged && h !== d) return true;
  }
  return false;
}

/** Squash-merge PR `pr` onto its base branch; returns the merge commit oid, or null on conflict. */
function squashMerge(repo: Repo, pr: PullRequest): string | null {
  const baseTip = resolveRefToCommit(repo, pr.base);
  const headTip = resolveRefToCommit(repo, pr.head);
  if (baseTip === null || headTip === null) return null;
  if (mergeConflicts(repo, baseTip, headTip)) return null;
  const headTree = refTargetTree(repo, headTip);
  if (headTree === null) return null;
  const message = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
  const mergeSha = createCommit(repo, headTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
  const s = nextSeq();
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedSeq = s;
  pr.mergeSha = mergeSha;
  pr.closedSeq = s;
  return mergeSha;
}

// --- global ids -------------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function globalId(kind: string, ...parts: Array<string | number>): string {
  return b64url(`${kind}:${parts.join(':')}`);
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

function prGlobalId(repo: Repo, pr: PullRequest): string {
  return globalId('PullRequest', repo.id, pr.number);
}

function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return globalId('IssueComment', repo.id, issue.number, comment.id);
}

function repoByDbId(dbId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

function findRepoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const dbId = Number(decoded.parts[0]);
  if (!Number.isInteger(dbId)) return null;
  return repoByDbId(dbId) ?? null;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const repo = repoByDbId(Number(decoded.parts[0]));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function findPrByGlobalId(id: string): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const repo = repoByDbId(Number(decoded.parts[0]));
  if (repo === undefined) return null;
  const pr = repo.pulls.get(Number(decoded.parts[1]));
  return pr === undefined ? null : { repo, pr };
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
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

function parseJsonBody(buffer: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buffer.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : match[1];
}

function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authed(req: IncomingMessage): boolean {
  const token = shopToken();
  const presented = bearerToken(req);
  if (presented === null) return false;
  if (token === '') return presented !== '';
  return presented === token;
}

/** Split a path into decoded segments. */
function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------------------------

function userObject(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    html_url: '',
    url: '/api/v3/user',
  };
}

function repoObject(repo: Repo): Record<string, unknown> {
  const defaultTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? null;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoAt(repo.createdSeq),
    updated_at: isoAt(repo.createdSeq),
    pushed_at: defaultTip === null ? isoAt(repo.createdSeq) : isoAt(repo.commitSeq.get(defaultTip) ?? repo.createdSeq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: DEFAULT_BRANCH,
  };
}

function labelObject(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', repo.id, label.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userObject(),
    labels: issue.labels.map((l) => labelObject(l, repo)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: isoAt(issue.createdSeq),
    updated_at: isoAt(issue.closedSeq ?? issue.createdSeq),
    closed_at: issue.closedSeq === null ? null : isoAt(issue.closedSeq),
    author_association: 'OWNER',
  };
}

function prObject(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: prGlobalId(repo, pr),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: '',
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user: userObject(),
    labels: [],
    locked: false,
    assignee: null,
    assignees: [],
    created_at: isoAt(pr.createdSeq),
    updated_at: isoAt(pr.closedSeq ?? pr.createdSeq),
    closed_at: pr.closedSeq === null ? null : isoAt(pr.closedSeq),
    merged_at: pr.mergedSeq === null ? null : isoAt(pr.mergedSeq),
    merge_commit_sha: pr.mergeSha,
    merged: pr.merged,
    mergeable: !pr.merged && !mergeConflicts(repo, resolveRefToCommit(repo, pr.base) ?? '', resolveRefToCommit(repo, pr.head) ?? ''),
    mergeable_state: pr.merged ? 'unknown' : 'clean',
    draft: false,
    head: {
      label: `${repo.owner}:${pr.head}`,
      ref: pr.head,
      sha: pr.headSha,
      user: userObject(),
      repo: repoObject(repo),
    },
    base: {
      label: `${repo.owner}:${pr.base}`,
      ref: pr.base,
      sha: pr.baseSha,
      user: userObject(),
      repo: repoObject(repo),
    },
    author_association: 'OWNER',
  };
}

function commentObject(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, issue, comment),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: '',
    body: comment.body,
    user: userObject(),
    created_at: isoAt(comment.createdSeq),
    updated_at: isoAt(comment.createdSeq),
    author_association: 'OWNER',
  };
}

function commitListObject(repo: Repo, sha: string): Record<string, unknown> {
  const object = lookupObject(repo, sha);
  const view = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const s = repo.commitSeq.get(sha) ?? repo.createdSeq;
  return {
    sha,
    node_id: globalId('Commit', repo.id, sha),
    commit: {
      // GitHub's REST view carries the message without git's trailing newline.
      message: (view?.message ?? '').replace(/\n$/, ''),
      author: { name: VIEWER.name, email: VIEWER.email, date: isoAt(s) },
      committer: { name: VIEWER.name, email: VIEWER.email, date: isoAt(s) },
      tree: { sha: view?.tree ?? '' },
    },
    author: userObject(),
    committer: userObject(),
    parents: (view?.parents ?? []).map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

/** Commits reachable from `tip`, newest first by creation sequence. */
function listCommits(repo: Repo, tip: string): string[] {
  const depths = commitDepths([tip], (oid) => lookupObject(repo, oid));
  return [...depths.keys()].sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
}

// ---------------------------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------------------------

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; hasNext: boolean; pageNum: number; perPage: number; totalPages: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return {
    page: items.slice(start, start + perPage),
    hasNext: pageNum < totalPages,
    pageNum,
    perPage,
    totalPages,
  };
}

/** The origin to stamp on absolute pagination URLs (the entry's own address, from Host). */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return host !== undefined && host !== '' ? `http://${host}` : '';
}

function linkHeader(basePath: string, query: URLSearchParams, pageNum: number, perPage: number, totalPages: number, origin: string): string {
  const q = new URLSearchParams(query);
  const parts: string[] = [];
  const build = (page: number): string => {
    q.set('page', String(page));
    q.set('per_page', String(perPage));
    return `<${origin}${basePath}?${q.toString()}>`;
  };
  if (pageNum < totalPages) parts.push(`${build(pageNum + 1)}; rel="next"`);
  if (totalPages > 1) parts.push(`${build(totalPages)}; rel="last"`);
  if (pageNum > 1) {
    parts.push(`${build(1)}; rel="first"`);
    parts.push(`${build(pageNum - 1)}; rel="prev"`);
  }
  return parts.join(', ');
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const segs = segments(path);
  // segs[0] === 'api', segs[1] === 'v3'
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const rest = segs.slice(2);
  const query = queryOf(req);

  const needBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
  let body: unknown = {};
  if (needBody) {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return true;
    }
    body = parsed.value;
  }

  // GET /api/v3/ — the API root.
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', api_version: '2022-11-28' });
    return true;
  }
  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, userObject());
    return true;
  }
  // GET/POST /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, hasNext, pageNum, perPage, totalPages } = paginate(all, query);
      const headers: Record<string, string> = {};
      if (hasNext) headers.link = linkHeader('/api/v3/user/repos', query, pageNum, perPage, totalPages, originOf(req));
      sendJson(res, 200, page.map(repoObject), headers);
      return true;
    }
    if (method === 'POST') {
      if (!isRecord(body)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Validation Failed: name is invalid' });
        return true;
      }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) {
        sendJson(res, 422, { message: `Repository ${VIEWER_LOGIN}/${name} already exists` });
        return true;
      }
      const repo = createRepoRecord(
        name,
        body.private === true,
        typeof body.description === 'string' ? body.description : '',
      );
      sendJson(res, 201, repoObject(repo));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const repo = getRepo(owner, name);
    const tail = rest.slice(3);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // GET /repos/{o}/{r}
    if (method === 'GET' && tail.length === 0) {
      sendJson(res, 200, repoObject(repo));
      return true;
    }
    // PATCH /repos/{o}/{r}
    if (method === 'PATCH' && tail.length === 0) {
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      }
      sendJson(res, 200, repoObject(repo));
      return true;
    }
    // DELETE /repos/{o}/{r}
    if (method === 'DELETE' && tail.length === 0) {
      repos.delete(repoKey(owner, name));
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return true;
    }
    // GET /repos/{o}/{r}/branches and /branches/{branch}
    if (method === 'GET' && tail.length >= 1 && tail[0] === 'branches') {
      if (tail.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref) ?? '' },
            protected: false,
          }));
        sendJson(res, 200, branches);
        return true;
      }
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }
    // GET /repos/{o}/{r}/commits
    if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
      const ref = query.get('sha') ?? DEFAULT_BRANCH;
      const tip = resolveRefToCommit(repo, ref);
      if (tip === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const commits = listCommits(repo, tip);
      const { page } = paginate(commits, query);
      sendJson(res, 200, page.map((sha) => commitListObject(repo, sha)));
      return true;
    }
    // POST /repos/{o}/{r}/git/refs and GET /git/refs/heads/{branch}
    if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
          sendJson(res, 422, { message: 'Validation Failed' });
          return true;
        }
        const ref = body.ref;
        const sha = body.sha;
        if (!ref.startsWith('refs/') || !isObjectId(sha) || lookupObject(repo, sha) === undefined) {
          sendJson(res, 422, { message: 'Validation Failed: sha does not exist' });
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: lookupObject(repo, sha)?.type ?? 'commit' } });
        return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = tail.slice(2).join('/');
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(res, 200, { ref, object: { sha, type: lookupObject(repo, sha)?.type ?? 'commit' } });
        return true;
      }
    }
    // /repos/{o}/{r}/contents/{path...}
    if (tail.length >= 1 && tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      const refParam = query.get('ref') ?? undefined;
      if (method === 'GET') {
        if (filePath === '') {
          // Root listing.
          const tree = refTargetTree(repo, refParam ?? DEFAULT_BRANCH);
          if (tree === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return true;
          }
          sendJson(res, 200, directoryEntries(repo, tree, ''));
          return true;
        }
        const tree = refTargetTree(repo, refParam ?? DEFAULT_BRANCH);
        if (tree === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const segments = filePath.split('/').filter((s) => s !== '');
        const node = treeNode(repo, tree, segments);
        if (node === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        if (node.kind === 'dir') {
          sendJson(res, 200, directoryEntries(repo, node.oid, filePath));
          return true;
        }
        const blob = lookupObject(repo, node.oid);
        if (blob === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(res, 200, fileEntry(repo, filePath, node.oid, blob.data));
        return true;
      }
      if (method === 'PUT') {
        if (!isRecord(body) || typeof body.content !== 'string' || typeof body.message !== 'string') {
          sendJson(res, 422, { message: 'Validation Failed: content and message are required' });
          return true;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
        const branchRef = `refs/heads/${branch}`;
        // A PUT naming a branch that does not exist yet creates it from the default tip.
        const baseTip = repo.refs.get(branchRef) ?? repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? null;
        const baseTree = baseTip === null ? null : refTargetTree(repo, baseTip);
        const currentBlob = blobAtPath(repo, baseTree, filePath);
        const shaGiven = typeof body.sha === 'string' ? body.sha : null;
        if (currentBlob !== null) {
          if (shaGiven === null || shaGiven.toLowerCase() !== currentBlob.toLowerCase()) {
            sendJson(res, 409, { message: 'The blob SHA does not match the current blob' });
            return true;
          }
        } else if (shaGiven !== null) {
          sendJson(res, 409, { message: 'The blob SHA does not match the current blob' });
          return true;
        }
        let contentBytes: Buffer;
        try {
          contentBytes = Buffer.from(body.content, 'base64');
        } catch {
          sendJson(res, 422, { message: 'Validation Failed: content is not valid base64' });
          return true;
        }
        const blobOid = putObject(repo, 'blob', contentBytes);
        const newTree = setPathInTree(repo, baseTree, filePath.split('/').filter((s) => s !== ''), blobOid);
        const parents = baseTip === null ? [] : [baseTip];
        const commitSha = createCommit(repo, newTree, parents, body.message);
        repo.refs.set(branchRef, commitSha);
        const status = currentBlob === null ? 201 : 200;
        sendJson(res, status, {
          content: fileEntry(repo, filePath, blobOid, contentBytes),
          commit: { sha: commitSha, message: body.message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const branch = isRecord(body) && typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
        const branchRef = `refs/heads/${branch}`;
        const baseTip = repo.refs.get(branchRef) ?? null;
        if (baseTip === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const baseTree = refTargetTree(repo, baseTip);
        const currentBlob = blobAtPath(repo, baseTree, filePath);
        if (currentBlob === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const shaGiven = isRecord(body) && typeof body.sha === 'string' ? body.sha : null;
        if (shaGiven !== null && shaGiven.toLowerCase() !== currentBlob.toLowerCase()) {
          sendJson(res, 409, { message: 'The blob SHA does not match the current blob' });
          return true;
        }
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
        const newTree = setPathInTree(repo, baseTree, filePath.split('/').filter((s) => s !== ''), null);
        const commitSha = createCommit(repo, newTree, [baseTip], message);
        repo.refs.set(branchRef, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
    }
    // POST /repos/{o}/{r}/labels
    if (method === 'POST' && tail.length === 1 && tail[0] === 'labels') {
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      const existing = repo.labels.get(body.name);
      if (existing !== undefined) {
        sendJson(res, 201, labelObject(existing, repo));
        return true;
      }
      const label: Label = {
        id: nextDbId,
        name: body.name,
        color: typeof body.color === 'string' ? body.color : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      nextDbId += 1;
      repo.labels.set(label.name, label);
      sendJson(res, 201, labelObject(label, repo));
      return true;
    }
    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (tail.length >= 1 && tail[0] === 'issues') {
      if (method === 'POST' && tail.length === 1) {
        if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
          sendJson(res, 422, { message: 'Validation Failed: title is required' });
          return true;
        }
        const labelNames = Array.isArray(body.labels) ? body.labels : [];
        const labels: Label[] = [];
        for (const entry of labelNames) {
          const name = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
          const label = repo.labels.get(name);
          if (label === undefined) {
            sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
            return true;
          }
          labels.push(label);
        }
        const issue = createIssueRecord(repo, body.title, typeof body.body === 'string' ? body.body : '', labels);
        sendJson(res, 201, issueObject(repo, issue));
        return true;
      }
      if (method === 'GET' && tail.length === 1) {
        const stateParam = (query.get('state') ?? 'open').toLowerCase();
        const sortParam = (query.get('sort') ?? 'created').toLowerCase();
        const directionParam = (query.get('direction') ?? 'desc').toLowerCase();
        let list = [...repo.issues.values()];
        if (stateParam === 'open' || stateParam === 'closed') list = list.filter((i) => i.state === stateParam);
        if (sortParam === 'created') {
          list.sort((a, b) => (directionParam === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, hasNext, pageNum, perPage, totalPages } = paginate(list, query);
        const headers: Record<string, string> = {};
        if (hasNext) headers.link = linkHeader(`/api/v3/repos/${owner}/${name}/issues`, query, pageNum, perPage, totalPages, originOf(req));
        sendJson(res, 200, page.map((i) => issueObject(repo, i)), headers);
        return true;
      }
      if (tail.length >= 2) {
        const number = Number(tail[1]);
        const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
        if (issue === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        if (method === 'GET' && tail.length === 2) {
          sendJson(res, 200, issueObject(repo, issue));
          return true;
        }
        if (method === 'PATCH' && tail.length === 2) {
          if (isRecord(body)) {
            if (body.state === 'closed' && issue.state !== 'closed') {
              issue.state = 'closed';
              issue.closedSeq = nextSeq();
            } else if (body.state === 'open' && issue.state !== 'open') {
              issue.state = 'open';
              issue.closedSeq = null;
            }
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
          }
          sendJson(res, 200, issueObject(repo, issue));
          return true;
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'POST') {
            if (!isRecord(body) || typeof body.body !== 'string') {
              sendJson(res, 422, { message: 'Validation Failed: body is required' });
              return true;
            }
            const comment: Comment = { id: nextDbId, body: body.body, createdSeq: nextSeq() };
            nextDbId += 1;
            issue.comments.push(comment);
            sendJson(res, 201, commentObject(repo, issue, comment));
            return true;
          }
          if (method === 'GET') {
            const { page } = paginate(issue.comments, query);
            sendJson(res, 200, page.map((c) => commentObject(repo, issue, c)));
            return true;
          }
        }
      }
    }
    // /repos/{o}/{r}/pulls[/{n}[/merge|/files]]
    if (tail.length >= 1 && tail[0] === 'pulls') {
      if (method === 'POST' && tail.length === 1) {
        if (!isRecord(body) || typeof body.head !== 'string' || typeof body.base !== 'string') {
          sendJson(res, 422, { message: 'Validation Failed: head and base are required' });
          return true;
        }
        const head = body.head.includes(':') ? body.head.split(':').pop()! : body.head;
        const base = body.base.includes(':') ? body.base.split(':').pop()! : body.base;
        const headTip = resolveRefToCommit(repo, head);
        const baseTip = resolveRefToCommit(repo, base);
        if (headTip === null || baseTip === null) {
          sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
          return true;
        }
        const existing = [...repo.pulls.values()].find((p) => p.head === head && p.base === base && p.state === 'open');
        if (existing !== undefined) {
          sendJson(res, 422, { message: 'A pull request already exists for these branches' });
          return true;
        }
        const pr = createPullRecord(repo, head, base, typeof body.title === 'string' ? body.title : '', typeof body.body === 'string' ? body.body : '', headTip, baseTip);
        sendJson(res, 201, prObject(repo, pr));
        return true;
      }
      if (method === 'GET' && tail.length === 1) {
        const stateParam = (query.get('state') ?? 'open').toLowerCase();
        let list = [...repo.pulls.values()];
        if (stateParam === 'open' || stateParam === 'closed') list = list.filter((p) => p.state === stateParam);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, hasNext, pageNum, perPage, totalPages } = paginate(list, query);
        const headers: Record<string, string> = {};
        if (hasNext) headers.link = linkHeader(`/api/v3/repos/${owner}/${name}/pulls`, query, pageNum, perPage, totalPages, originOf(req));
        sendJson(res, 200, page.map((p) => prObject(repo, p)), headers);
        return true;
      }
      if (tail.length >= 2) {
        const number = Number(tail[1]);
        const pr = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
        if (pr === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        if (method === 'GET' && tail.length === 2) {
          sendJson(res, 200, prObject(repo, pr));
          return true;
        }
        if (method === 'GET' && tail.length === 3 && tail[2] === 'files') {
          const { page } = paginate(pr.files, query);
          sendJson(
            res,
            200,
            page.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })),
          );
          return true;
        }
        if (method === 'PUT' && tail.length === 3 && tail[2] === 'merge') {
          const baseTip = resolveRefToCommit(repo, pr.base);
          const headTip = resolveRefToCommit(repo, pr.head);
          if (pr.merged || pr.state === 'closed') {
            sendJson(res, 405, { message: 'Pull request already merged or closed' });
            return true;
          }
          if (baseTip === null || headTip === null) {
            sendJson(res, 405, { message: 'Head or base branch is missing' });
            return true;
          }
          if (mergeConflicts(repo, baseTip, headTip)) {
            sendJson(res, 405, { message: 'Merge conflict' });
            return true;
          }
          const mergeSha = squashMerge(repo, pr);
          if (mergeSha === null) {
            sendJson(res, 405, { message: 'Merge conflict' });
            return true;
          }
          sendJson(res, 200, { sha: mergeSha, merged: true, message: `Pull Request #${pr.number} successfully merged` });
          return true;
        }
      }
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

function createIssueRecord(repo: Repo, title: string, bodyText: string, labels: Label[]): Issue {
  const s = nextSeq();
  const issue: Issue = {
    id: nextDbId,
    number: repo.nextNumber,
    title,
    body: bodyText,
    state: 'open',
    labels,
    createdSeq: s,
    closedSeq: null,
    comments: [],
  };
  nextDbId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullRecord(repo: Repo, head: string, base: string, title: string, bodyText: string, headSha: string, baseSha: string): PullRequest {
  const s = nextSeq();
  const baseTree = refTargetTree(repo, baseSha);
  const headTree = refTargetTree(repo, headSha);
  const pr: PullRequest = {
    id: nextDbId,
    number: repo.nextNumber,
    title,
    body: bodyText,
    state: 'open',
    merged: false,
    head,
    base,
    headSha,
    baseSha,
    files: diffTrees(repo, baseTree, headTree),
    createdSeq: s,
    closedSeq: null,
    mergedSeq: null,
    mergeSha: null,
  };
  nextDbId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pr.number, pr);
  return pr;
}

/** Walk a tree by path segments; returns the node (file or dir) or null. */
function treeNode(repo: Repo, rootOid: string, segments: readonly string[]): { kind: 'file' | 'dir'; oid: string } | null {
  let current = rootOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = lookupObject(repo, current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { kind: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid };
    current = entry.oid;
  }
  return null;
}

function fileEntry(repo: Repo, path: string, blobOid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: '',
    html_url: '',
    download_url: null,
  };
}

function directoryEntries(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const object = lookupObject(repo, treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      return {
        type: 'dir',
        size: 0,
        name: entry.name,
        path,
        sha: entry.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git_url: '',
        html_url: '',
        download_url: null,
      };
    }
    const blob = lookupObject(repo, entry.oid);
    return {
      type: 'file',
      size: blob?.data.length ?? 0,
      name: entry.name,
      path,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git_url: '',
      html_url: '',
      download_url: null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// GraphQL — parser for the fixed document subset
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlSelection {
  kind: 'field' | 'fragment';
  name?: string;
  alias?: string;
  args?: Map<string, GqlValue>;
  children?: GqlSelection[];
  typeCondition?: string;
}

interface GqlDocument {
  operation: 'query' | 'mutation';
  variableDefinitions: Map<string, GqlValue>;
  selections: GqlSelection[];
}

function gqlTokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if ('{}():[]!...='.includes(c) || c === '.') {
      if (c === '.' && source.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      tokens.push(c);
      i += 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = gqlTokenize(source);
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): GqlDocument {
    let operation: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      operation = this.next() as 'query' | 'mutation';
      // Optional operation name.
      if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') this.next();
    }
    const variableDefinitions = new Map<string, GqlValue>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const varToken = this.next();
        if (!varToken.startsWith('$')) continue;
        const name = varToken.slice(1);
        this.expect(':');
        const typeName = this.next();
        if (this.peek() === '!') this.next();
        // Default value.
        if (this.peek() === '=') {
          this.next();
          this.parseValue();
        }
        variableDefinitions.set(name, { kind: 'enum', value: typeName });
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { operation, variableDefinitions, selections };
  }

  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        const children = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, children };
      }
      const name = this.next();
      return { kind: 'fragment', name };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    let args: Map<string, GqlValue> | undefined;
    if (this.peek() === '(') {
      this.next();
      args = new Map();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    let children: GqlSelection[] | undefined;
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, children };
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.startsWith('$')) return { kind: 'variable', name: token.slice(1) };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const name = this.next();
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveGqlValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.fields) out[k] = resolveGqlValue(v, variables);
      return out;
    }
  }
}

function argsOf(sel: GqlSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (sel.args !== undefined) {
    for (const [k, v] of sel.args) out[k] = resolveGqlValue(v, variables);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// GraphQL — schema (field validation) and resolvers
// ---------------------------------------------------------------------------------------------

interface GqlContext {
  errors: string[];
  variables: Record<string, unknown>;
}

function gqlTypeOf(value: unknown): string {
  if (value === null || value === undefined) return 'Unknown';
  if (typeof value === 'object' && value !== null && '__typename' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).__typename);
  }
  return 'Unknown';
}

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', 'search'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'description',
    'isPrivate', 'url',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'createdAt', 'author',
  ],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  RepositoryOwner: ['login', 'id'],
  Actor: ['login', 'id'],
  BranchRef: ['name'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueCommentConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'type', 'description'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'type', 'description'],
  File: ['path'],
  PullRequestFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestFileEdge: ['node', 'cursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  Node: ['id'],
  SearchResultItemConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
};

function schemaFieldsFor(typeName: string): string[] | null {
  if (typeName in SCHEMA_FIELDS) return SCHEMA_FIELDS[typeName];
  return null;
}

function stateToGql(state: 'open' | 'closed', merged: boolean): string {
  if (merged) return 'MERGED';
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: stateToGql(issue.state, false),
    createdAt: isoAt(issue.createdSeq),
    author: { __typename: 'User', id: globalId('User', VIEWER.id), login: VIEWER_LOGIN, name: VIEWER.name },
    labels: { __typename: 'LabelConnection', nodes: issue.labels.map((l) => ({ __typename: 'Label', id: globalId('Label', repo.id, l.id), name: l.name, color: l.color, description: l.description })) },
    comments: {
      __typename: 'IssueCommentConnection',
      nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: commentGlobalId(repo, issue, c), body: c.body, createdAt: isoAt(c.createdSeq) })),
    },
  };
}

function prNode(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: prGlobalId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: stateToGql(pr.state, pr.merged),
    merged: pr.merged,
    mergeable: pr.merged ? 'UNKNOWN' : mergeConflicts(repo, resolveRefToCommit(repo, pr.base) ?? '', resolveRefToCommit(repo, pr.head) ?? '') ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pr.head,
    baseRefName: pr.base,
    headRefOid: pr.headSha,
    baseRefOid: pr.baseSha,
    createdAt: isoAt(pr.createdSeq),
    author: { __typename: 'User', id: globalId('User', VIEWER.id), login: VIEWER_LOGIN, name: VIEWER.name },
    files: {
      __typename: 'PullRequestFileConnection',
      nodes: pr.files.map((f) => ({ __typename: 'File', path: f.filename })),
    },
  };
}

function repoNode(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', id: globalId('User', VIEWER.id), login: repo.owner, name: VIEWER.name },
    defaultBranchRef: repo.refs.has(`refs/heads/${DEFAULT_BRANCH}`)
      ? { __typename: 'BranchRef', name: DEFAULT_BRANCH }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: isoAt(repo.createdSeq),
    description: repo.description,
    isPrivate: repo.isPrivate,
    url: '',
  };
}

function userNode(): Record<string, unknown> {
  return {
    __typename: 'User',
    id: globalId('User', VIEWER.id),
    login: VIEWER_LOGIN,
    name: VIEWER.name,
    email: VIEWER.email,
    databaseId: VIEWER.id,
  };
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return -1;
    return Number(match[1]);
  } catch {
    return -1;
  }
}

function connectionResult<T>(items: readonly T[], first: unknown, after: unknown): Record<string, unknown> {
  const afterIndex = decodeCursor(after);
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const size = typeof first === 'number' && first > 0 ? first : items.length;
  const page = items.slice(start, start + size);
  const endIndex = start + page.length - 1;
  return {
    nodes: page,
    edges: page.map((node, i) => ({ cursor: encodeCursor(start + i), node })),
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length === 0 ? null : encodeCursor(start),
      endCursor: page.length === 0 ? null : encodeCursor(endIndex),
    },
  };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

function typeIntrospection(name: string): Record<string, unknown> {
  const fields = TYPE_FIELDS[name];
  const enumValues = TYPE_ENUM_VALUES[name];
  return {
    __typename: '__Type',
    name,
    kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
    fields: fields === undefined
      ? null
      : fields.map((f) => ({ __typename: '__Field', name: f, type: { __typename: '__Type', name: 'String', kind: 'SCALAR' }, description: null })),
    enumValues: enumValues === undefined
      ? null
      : enumValues.map((v) => ({ __typename: '__EnumValue', name: v, description: null })),
    description: null,
  };
}

/** Resolve a selection set against `value` of GraphQL type `typeName`. */
function resolveSelections(
  value: unknown,
  typeName: string,
  selections: GqlSelection[],
  ctx: GqlContext,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      const condition = sel.typeCondition;
      if (condition === undefined || condition === typeName || condition === 'Node') {
        const merged = resolveSelections(value, typeName, sel.children ?? [], ctx);
        if (merged !== null) Object.assign(out, merged);
      }
      continue;
    }
    const fieldName = sel.name ?? '';
    const key = sel.alias ?? fieldName;
    const allowed = schemaFieldsFor(typeName);
    if (allowed !== null && !allowed.includes(fieldName)) {
      ctx.errors.push(`Cannot query field "${fieldName}" on type "${typeName}".`);
      continue;
    }
    out[key] = resolveField(value, typeName, sel, ctx);
  }
  return out;
}

function resolveField(
  value: unknown,
  typeName: string,
  sel: GqlSelection,
  ctx: GqlContext,
): unknown {
  const fieldName = sel.name ?? '';
  const args = argsOf(sel, ctx.variables);
  const record = value as Record<string, unknown>;
  const children = sel.children ?? [];

  // Connection sub-fields.
  if (typeName === 'Repository' && (fieldName === 'issues' || fieldName === 'pullRequests')) {
    const repo = record.__repo as Repo | undefined;
    if (repo === undefined) return null;
    if (fieldName === 'issues') {
      let list = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s)));
        list = list.filter((i) => wanted.has(stateToGql(i.state, false)));
      }
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      if (orderBy !== undefined && orderBy.field === 'CREATED_AT') {
        list.sort((a, b) => (orderBy.direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      } else {
        list.sort((a, b) => b.createdSeq - a.createdSeq);
      }
      const nodes = list.map((i) => issueNode(repo, i));
      if (children.length === 0) return { nodes };
      const conn = connectionResult(nodes, args.first, args.after);
      return resolveSelections(conn, 'IssueConnection', children, ctx);
    }
    let list = [...repo.pulls.values()];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s)));
      list = list.filter((p) => wanted.has(stateToGql(p.state, p.merged)));
    }
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    const nodes = list.map((p) => prNode(repo, p));
    if (children.length === 0) return { nodes };
    const conn = connectionResult(nodes, args.first, args.after);
    return resolveSelections(conn, 'PullRequestConnection', children, ctx);
  }
  if (typeName === 'Repository' && fieldName === 'issue') {
    const repo = record.__repo as Repo | undefined;
    if (repo === undefined) return null;
    const number = args.number;
    if (typeof number !== 'number') return null;
    const issue = repo.issues.get(number);
    if (issue === undefined) return null;
    if (children.length === 0) return issueNode(repo, issue);
    return resolveSelections(issueNode(repo, issue), 'Issue', children, ctx);
  }
  if (typeName === 'Repository' && fieldName === 'pullRequest') {
    const repo = record.__repo as Repo | undefined;
    if (repo === undefined) return null;
    const number = args.number;
    if (typeof number !== 'number') return null;
    const pr = repo.pulls.get(number);
    if (pr === undefined) return null;
    if (children.length === 0) return prNode(repo, pr);
    return resolveSelections(prNode(repo, pr), 'PullRequest', children, ctx);
  }
  if (typeName === 'PullRequest' && fieldName === 'files') {
    const files = record.files as Record<string, unknown> | undefined;
    if (files === undefined) return null;
    if (children.length === 0) return files;
    const conn = connectionResult((files.nodes as unknown[]) ?? [], args.first, args.after);
    return resolveSelections(conn, 'PullRequestFileConnection', children, ctx);
  }
  if (typeName === 'Issue' && fieldName === 'labels') {
    const labels = record.labels as Record<string, unknown> | undefined;
    if (labels === undefined) return null;
    if (children.length === 0) return labels;
    const nodes = (labels.nodes as unknown[]) ?? [];
    return resolveSelections({ nodes }, 'LabelConnection', children, ctx);
  }
  if (typeName === 'Issue' && fieldName === 'comments') {
    const comments = record.comments as Record<string, unknown> | undefined;
    if (comments === undefined) return null;
    if (children.length === 0) return comments;
    const nodes = (comments.nodes as unknown[]) ?? [];
    const conn = connectionResult(nodes, args.first, args.after);
    return resolveSelections(conn, 'IssueCommentConnection', children, ctx);
  }
  if ((typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'IssueCommentConnection' || typeName === 'PullRequestFileConnection') && fieldName === 'nodes') {
    const nodes = (record.nodes as Array<Record<string, unknown>>) ?? [];
    const itemType =
      typeName === 'IssueConnection' ? 'Issue'
      : typeName === 'PullRequestConnection' ? 'PullRequest'
      : typeName === 'IssueCommentConnection' ? 'IssueComment'
      : 'File';
    return nodes.map((node) => (children.length === 0 ? node : resolveSelections(node, itemType, children, ctx)));
  }
  if ((typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'IssueCommentConnection' || typeName === 'PullRequestFileConnection') && fieldName === 'edges') {
    const edges = (record.edges as Array<Record<string, unknown>>) ?? [];
    const edgeType =
      typeName === 'IssueConnection' ? 'IssueEdge'
      : typeName === 'PullRequestConnection' ? 'PullRequestEdge'
      : typeName === 'IssueCommentConnection' ? 'IssueCommentEdge'
      : 'PullRequestFileEdge';
    return edges.map((edge) => (children.length === 0 ? edge : resolveSelections(edge, edgeType, children, ctx)));
  }
  if ((typeName === 'IssueEdge' || typeName === 'PullRequestEdge' || typeName === 'IssueCommentEdge' || typeName === 'PullRequestFileEdge') && fieldName === 'node') {
    const node = record.node as Record<string, unknown>;
    const itemType =
      typeName === 'IssueEdge' ? 'Issue'
      : typeName === 'PullRequestEdge' ? 'PullRequest'
      : typeName === 'IssueCommentEdge' ? 'IssueComment'
      : 'File';
    if (children.length === 0) return node;
    return resolveSelections(node, itemType, children, ctx);
  }
  if (typeName === '__Type' && fieldName === 'fields') {
    const fields = record.fields as Array<Record<string, unknown>> | null;
    if (fields === null) return null;
    return fields.map((f) => (children.length === 0 ? f : resolveSelections(f, '__Field', children, ctx)));
  }
  if (typeName === '__Type' && fieldName === 'enumValues') {
    const values = record.enumValues as Array<Record<string, unknown>> | null;
    if (values === null) return null;
    return values.map((v) => (children.length === 0 ? v : resolveSelections(v, '__EnumValue', children, ctx)));
  }

  // Scalar / object fields.
  const raw = record[fieldName];
  if (raw === undefined) return null;
  if (children.length === 0 || raw === null || typeof raw !== 'object') return raw;
  const childType = gqlTypeOf(raw);
  if (childType === 'Unknown') return raw;
  return resolveSelections(raw, childType, children, ctx);
}

function resolveRootField(sel: GqlSelection, ctx: GqlContext, isMutation: boolean): unknown {
  const fieldName = sel.name ?? '';
  const args = argsOf(sel, ctx.variables);
  const children = sel.children ?? [];

  if (!isMutation && fieldName === 'viewer') {
    const node = userNode();
    if (children.length === 0) return node;
    return resolveSelections(node, 'User', children, ctx);
  }
  if (!isMutation && fieldName === 'repository') {
    const owner = args.owner;
    const name = args.name;
    const repo = typeof owner === 'string' && typeof name === 'string' ? getRepo(owner, name) : undefined;
    if (repo === undefined) return null;
    const node = { ...repoNode(repo), __repo: repo };
    if (children.length === 0) return node;
    return resolveSelections(node, 'Repository', children, ctx);
  }
  if (!isMutation && fieldName === 'node') {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const repo = findRepoByGlobalId(id);
      if (repo === null) return null;
      const node = { ...repoNode(repo), __repo: repo };
      if (children.length === 0) return node;
      return resolveSelections(node, 'Repository', children, ctx);
    }
    if (decoded.kind === 'Issue') {
      const found = findIssueByGlobalId(id);
      if (found === null) return null;
      const node = issueNode(found.repo, found.issue);
      if (children.length === 0) return node;
      return resolveSelections(node, 'Issue', children, ctx);
    }
    if (decoded.kind === 'PullRequest') {
      const found = findPrByGlobalId(id);
      if (found === null) return null;
      const node = prNode(found.repo, found.pr);
      if (children.length === 0) return node;
      return resolveSelections(node, 'PullRequest', children, ctx);
    }
    return null;
  }
  if (!isMutation && fieldName === '__type') {
    const name = args.name;
    if (typeof name !== 'string') return null;
    const node = typeIntrospection(name);
    if (children.length === 0) return node;
    return resolveSelections(node, '__Type', children, ctx);
  }
  if (!isMutation && fieldName === 'search') {
    const conn: Record<string, unknown> = { nodes: [], edges: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    if (children.length === 0) return conn;
    return resolveSelections(conn, 'SearchResultItemConnection', children, ctx);
  }

  if (isMutation) {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (fieldName === 'createIssue') {
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
      if (repo === null || typeof input.title !== 'string') return null;
      const issue = createIssueRecord(repo, input.title, typeof input.body === 'string' ? input.body : '', []);
      const payload: Record<string, unknown> = {
        __typename: 'CreateIssuePayload',
        issue: issueNode(repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      };
      if (children.length === 0) return payload;
      return resolveSelections(payload, 'CreateIssuePayload', children, ctx);
    }
    if (fieldName === 'closeIssue') {
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(input.issueId) : null;
      if (found === null) return null;
      found.issue.state = 'closed';
      found.issue.closedSeq = nextSeq();
      const payload: Record<string, unknown> = {
        __typename: 'CloseIssuePayload',
        issue: issueNode(found.repo, found.issue),
        clientMutationId: input.clientMutationId ?? null,
      };
      if (children.length === 0) return payload;
      return resolveSelections(payload, 'CloseIssuePayload', children, ctx);
    }
    if (fieldName === 'createPullRequest') {
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
      if (repo === null || typeof input.headRefName !== 'string' || typeof input.baseRefName !== 'string') return null;
      const headTip = resolveRefToCommit(repo, input.headRefName);
      const baseTip = resolveRefToCommit(repo, input.baseRefName);
      if (headTip === null || baseTip === null) return null;
      const pr = createPullRecord(repo, input.headRefName, input.baseRefName, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', headTip, baseTip);
      const payload: Record<string, unknown> = {
        __typename: 'CreatePullRequestPayload',
        pullRequest: prNode(repo, pr),
        clientMutationId: input.clientMutationId ?? null,
      };
      if (children.length === 0) return payload;
      return resolveSelections(payload, 'CreatePullRequestPayload', children, ctx);
    }
    if (fieldName === 'mergePullRequest') {
      const found = typeof input.pullRequestId === 'string' ? findPrByGlobalId(input.pullRequestId) : null;
      if (found === null) return null;
      const mergeSha = squashMerge(found.repo, found.pr);
      const payload: Record<string, unknown> = {
        __typename: 'MergePullRequestPayload',
        pullRequest: prNode(found.repo, found.pr),
        clientMutationId: input.clientMutationId ?? null,
      };
      void mergeSha;
      if (children.length === 0) return payload;
      return resolveSelections(payload, 'MergePullRequestPayload', children, ctx);
    }
    if (fieldName === 'addComment') {
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(input.subjectId) : null;
      if (found === null || typeof input.body !== 'string') return null;
      const comment: Comment = { id: nextDbId, body: input.body, createdSeq: nextSeq() };
      nextDbId += 1;
      found.issue.comments.push(comment);
      const edge: Record<string, unknown> = {
        __typename: 'IssueCommentEdge',
        cursor: encodeCursor(found.issue.comments.length - 1),
        node: { __typename: 'IssueComment', id: commentGlobalId(found.repo, found.issue, comment), body: comment.body, createdAt: isoAt(comment.createdSeq) },
      };
      const payload: Record<string, unknown> = {
        __typename: 'AddCommentPayload',
        commentEdge: edge,
        clientMutationId: input.clientMutationId ?? null,
      };
      if (children.length === 0) return payload;
      return resolveSelections(payload, 'AddCommentPayload', children, ctx);
    }
  }

  const allowed = schemaFieldsFor(isMutation ? 'Mutation' : 'Query');
  if (allowed !== null && !allowed.includes(fieldName)) {
    ctx.errors.push(`Cannot query field "${fieldName}" on type "${isMutation ? 'Mutation' : 'Query'}".`);
    return null;
  }
  return null;
}

function executeGqlDocument(doc: GqlDocument, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: GqlContext = { errors: [], variables };
  const isMutation = doc.operation === 'mutation';
  const data: Record<string, unknown> = {};
  for (const sel of doc.selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name ?? '';
    const value = resolveRootField(sel, ctx, isMutation);
    if (value !== undefined) data[key] = value;
  }
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors.map((message) => ({ message }));
  return out;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { errors: [{ message: 'GraphQL query is required' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    let doc: GqlDocument;
    try {
      doc = new GqlParser(entry.query).parseDocument();
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'Failed to parse query' }] };
    }
    return executeGqlDocument(doc, variables);
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(parsed.value));
  return true;
}

// ---------------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------------

const MCP_SERVER_NAME = 'github-core-clone-forge';
const MCP_SERVER_VERSION = '1.0.0';
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpTextResult(id: unknown, result: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    },
  };
}

function mcpErrorResult(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function mcpToolError(id: unknown, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    result: {
      content: [{ type: 'text', text: message }],
      isError: true,
    },
  };
}

function callMcpTool(name: string, args: Record<string, unknown>): { ok: boolean; result: unknown } {
  const missing = (required: string[]): string | null => {
    for (const key of required) {
      if (args[key] === undefined || args[key] === null || args[key] === '') return key;
    }
    return null;
  };
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { ok: false, result: `Unknown tool: ${name}` };
  const missingKey = missing(tool.inputSchema.required);
  if (missingKey !== null) return { ok: false, result: `Missing required argument: ${missingKey}` };

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (repos.has(repoKey(VIEWER_LOGIN, repoName))) {
      return { ok: false, result: `Repository ${VIEWER_LOGIN}/${repoName} already exists` };
    }
    const repo = createRepoRecord(
      repoName,
      args.private === true,
      typeof args.description === 'string' ? args.description : '',
    );
    return { ok: true, result: repoObject(repo) };
  }
  if (name === 'get_repo') {
    const repo = getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { ok: false, result: 'Not Found' };
    return { ok: true, result: repoObject(repo) };
  }
  if (name === 'create_issue') {
    const repo = getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { ok: false, result: 'Not Found' };
    const issue = createIssueRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return { ok: true, result: issueObject(repo, issue) };
  }
  if (name === 'list_issues') {
    const repo = getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { ok: false, result: 'Not Found' };
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    let list = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    return { ok: true, result: list.map((i) => issueObject(repo, i)) };
  }
  if (name === 'create_pull_request') {
    const repo = getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { ok: false, result: 'Not Found' };
    const head = String(args.head);
    const base = String(args.base);
    const headTip = resolveRefToCommit(repo, head);
    const baseTip = resolveRefToCommit(repo, base);
    if (headTip === null || baseTip === null) {
      return { ok: false, result: 'Validation Failed: head or base branch does not exist' };
    }
    const pr = createPullRecord(repo, head, base, String(args.title), typeof args.body === 'string' ? args.body : '', headTip, baseTip);
    return { ok: true, result: prObject(repo, pr) };
  }
  if (name === 'merge_pull_request') {
    const repo = getRepo(String(args.owner), String(args.repo));
    if (repo === undefined) return { ok: false, result: 'Not Found' };
    const number = Number(args.pull_number);
    const pr = repo.pulls.get(number);
    if (pr === undefined) return { ok: false, result: 'Not Found' };
    if (pr.merged || pr.state === 'closed') return { ok: false, result: 'Pull request already merged or closed' };
    const mergeSha = squashMerge(repo, pr);
    if (mergeSha === null) return { ok: false, result: 'Merge conflict' };
    return { ok: true, result: { sha: mergeSha, merged: true, message: `Pull Request #${pr.number} successfully merged` } };
  }
  return { ok: false, result: `Unknown tool: ${name}` };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  // Auth is checked before JSON parsing.
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const request = parsed.value;
  if (!isRecord(request)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  const protocolVersion =
    typeof params._meta === 'object' && params._meta !== null && typeof (params._meta as Record<string, unknown>).protocolVersion === 'string'
      ? String((params._meta as Record<string, unknown>).protocolVersion)
      : typeof req.headers['mcp-protocol-version'] === 'string'
        ? (req.headers['mcp-protocol-version'] as string)
        : MCP_SUPPORTED_VERSIONS[0];

  if (method === 'server/discover') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        protocolVersion,
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
        capabilities: { tools: {} },
      },
    });
    return true;
  }
  if (method === 'initialize') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        capabilities: { tools: {} },
      },
    });
    return true;
  }
  if (method === 'notifications/initialized') {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (tool === undefined) {
      sendJson(res, 200, mcpErrorResult(id, -32602, `Unknown tool: ${toolName}`));
      return true;
    }
    const outcome = callMcpTool(toolName, args);
    if (!outcome.ok) {
      sendJson(res, 200, mcpToolError(id, String(outcome.result)));
      return true;
    }
    sendJson(res, 200, mcpTextResult(id, outcome.result));
    return true;
  }
  sendJson(res, 200, mcpErrorResult(id, -32601, `Method not found: ${method}`));
  return true;
}

// ---------------------------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------------------------


/** Parse pkt-line framed data into logical lines (excluding flush/delim markers). */
function parsePktLines(buffer: Buffer): Array<{ kind: 'line' | 'flush' | 'delim'; text: string }> {
  const out: Array<{ kind: 'line' | 'flush' | 'delim'; text: string }> = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(size)) break;
    if (size === 0) {
      out.push({ kind: 'flush', text: '' });
      offset += 4;
      continue;
    }
    if (size === 1) {
      out.push({ kind: 'delim', text: '' });
      offset += 4;
      continue;
    }
    if (offset + size > buffer.length) break;
    out.push({ kind: 'line', text: buffer.subarray(offset + 4, offset + size).toString('utf8') });
    offset += size;
  }
  return out;
}

interface FetchPlan {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute the object set for a fetch: the depth-limited closure of wants, minus the full
 * object closure of haves (stopping at shallow boundaries, whose parents the client lacks),
 * with shallow-info.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowOids: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set<string>(shallowOids);
  // Every object the client already holds: the full closure of haves — commits, their trees
  // and blobs — stopping at shallow boundaries (a boundary's tree is held, its parents are not).
  const haveReachable = new Set<string>();
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (haveReachable.has(oid)) continue;
    const object = lookupObject(repo, oid);
    if (object === undefined) continue;
    haveReachable.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!shallowSet.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  // The depth-limited walk from wants. Haves never stop this walk: deepening asks for the
  // ancestors of a commit the client already holds, so the walk passes through it.
  const wanted = new Set<string>();
  const shallow = new Set<string>();
  interface DepthItem {
    oid: string;
    depth: number;
  }
  const work: DepthItem[] = wants.map((oid) => ({ oid, depth: 1 }));
  const visited = new Set<string>();
  while (work.length > 0) {
    const item = work.shift()!;
    const object = lookupObject(repo, item.oid);
    if (object === undefined) continue;
    if (object.type !== 'commit') {
      if (!haveReachable.has(item.oid)) wanted.add(item.oid);
      continue;
    }
    if (visited.has(item.oid)) continue;
    visited.add(item.oid);
    const commit = parseCommit(object.data);
    const atLimit = depth !== null && item.depth >= depth;
    wanted.add(item.oid);
    if (atLimit) {
      shallow.add(item.oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (!visited.has(parent)) work.push({ oid: parent, depth: item.depth + 1 });
    }
  }
  // Objects reachable from wanted commits (trees + blobs), excluding anything the client holds.
  const objects = new Set<string>();
  const addClosure = (oid: string): void => {
    if (objects.has(oid) || haveReachable.has(oid)) return;
    const object = lookupObject(repo, oid);
    if (object === undefined) return;
    objects.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addClosure(commit.tree);
      for (const parent of commit.parents) {
        // Parents of a wanted commit are included only when they are wanted too.
        if (wanted.has(parent)) addClosure(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) addClosure(entry.oid);
    } else if (object.type === 'tag') {
      addClosure(parseTag(object.data).object);
    }
  };
  for (const oid of wanted) addClosure(oid);
  // unshallow: old shallow boundaries whose parents are now included.
  const unshallow = new Set<string>();
  for (const boundary of shallowOids) {
    const object = lookupObject(repo, boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.some((p) => objects.has(p))) unshallow.add(boundary);
  }
  return {
    oids: [...objects].sort(),
    shallow: [...shallow].sort(),
    unshallow: [...unshallow].sort(),
  };
}

function refAdvertisementLines(repo: Repo): string[] {
  const lines: string[] = [];
  const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [ref, oid] of sorted) lines.push(`${oid} ${ref}`);
  return lines;
}

function v0Advertisement(service: string, repo: Repo): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(encodePktLine(`# service=${service}\n`));
  chunks.push(pktFlush());
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${DEFAULT_BRANCH} object-format=sha1`
      : 'report-status side-band-64k delete-refs';
  const lines = refAdvertisementLines(repo);
  if (lines.length === 0) {
    chunks.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      if (index === 0) chunks.push(encodePktLine(`${line}\0${caps}\n`));
      else chunks.push(encodePktLine(`${line}\n`));
    });
  }
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (headTip !== undefined && !lines.some((l) => l.startsWith(headTip))) {
    chunks.push(encodePktLine(`${headTip} HEAD\n`));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo): void {
  const query = queryOf(req);
  const service = query.get('service') ?? '';
  const isV2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
  if (service === 'git-upload-pack') {
    if (isV2) {
      const chunks: Buffer[] = [];
      chunks.push(encodePktLine('version 2\n'));
      chunks.push(encodePktLine('agent=github-core-clone-forge/1.0.0\n'));
      chunks.push(encodePktLine('ls-refs=unborn\n'));
      chunks.push(encodePktLine('fetch=shallow wait-for-done\n'));
      chunks.push(encodePktLine('object-format=sha1\n'));
      chunks.push(encodePktLine('server-option\n'));
      chunks.push(encodePktLine('object-info\n'));
      chunks.push(pktFlush());
      sendRaw(res, 200, Buffer.concat(chunks), 'application/x-git-upload-pack-advertisement');
      return;
    }
    sendRaw(res, 200, v0Advertisement('git-upload-pack', repo), 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    sendRaw(res, 200, v0Advertisement('git-receive-pack', repo), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendJson(res, 400, { message: 'Unknown service' });
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const raw = await readBody(req);
  const isV2 = req.headers['git-protocol'] === 'version=2';
  if (isV2) {
    const lines = parsePktLines(raw);
    let command = '';
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowOids: string[] = [];
    let depth: number | null = null;
    let filterSpec = '';
    for (const entry of lines) {
      if (entry.kind !== 'line') continue;
      const text = entry.text.replace(/\n$/, '');
      if (text.startsWith('command=')) command = text.slice('command='.length);
      else if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallowOids.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
      else if (text.startsWith('filter ')) filterSpec = text.slice(7).trim();
    }
    void filterSpec;
    if (command === 'ls-refs') {
      let refPrefixes: string[] = [];
      let peel = false;
      let unborn = false;
      for (const entry of lines) {
        if (entry.kind !== 'line') continue;
        const text = entry.text.replace(/\n$/, '');
        if (text.startsWith('ref-prefix ')) refPrefixes.push(text.slice('ref-prefix '.length));
        else if (text === 'peel') peel = true;
        else if (text === 'unborn') unborn = true;
      }
      void unborn;
      const chunks: Buffer[] = [];
      const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
      const includeHead = refPrefixes.length === 0;
      if (includeHead) {
        if (headTip !== undefined) chunks.push(encodePktLine(`${headTip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
        else chunks.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
      }
      for (const [ref, oid] of sorted) {
        if (refPrefixes.length > 0 && !refPrefixes.some((p) => ref.startsWith(p))) continue;
        let suffix = '';
        if (peel) {
          const peeled = peelToCommit(repo, oid);
          if (peeled !== null && peeled !== oid) suffix = ` peeled:${peeled}`;
        }
        chunks.push(encodePktLine(`${oid} ${ref}${suffix}\n`));
      }
      chunks.push(pktFlush());
      sendRaw(res, 200, Buffer.concat(chunks), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const plan = planFetch(repo, wants, haves, shallowOids, depth);
      const chunks: Buffer[] = [];
      // One section per name: the header line, then its content lines, then a delim packet
      // closing the section. (A delim right after the header would end the section empty.)
      chunks.push(encodePktLine('acknowledgments\n'));
      chunks.push(encodePktLine('NAK\n'));
      chunks.push(pktDelim());
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        chunks.push(encodePktLine('shallow-info\n'));
        for (const oid of plan.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
        for (const oid of plan.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
        chunks.push(pktDelim());
      }
      if (plan.oids.length > 0) {
        chunks.push(encodePktLine('packfile\n'));
        const objects = plan.oids.map((oid) => lookupObject(repo, oid)!).filter(Boolean);
        chunks.push(...sidebandPackets(writePack(objects, repo)));
        chunks.push(pktDelim());
      }
      chunks.push(pktFlush());
      sendRaw(res, 200, Buffer.concat(chunks), 'application/x-git-upload-pack-result');
      return;
    }
    sendRaw(res, 200, pktFlush(), 'application/x-git-upload-pack-result');
    return;
  }
  // Protocol v0 fetch.
  const lines = parsePktLines(raw);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowOids: string[] = [];
  let depth: number | null = null;
  for (const entry of lines) {
    if (entry.kind !== 'line') continue;
    const text = entry.text.replace(/\n$/, '');
    const first = text.split(' ')[0];
    if (text.startsWith('want ')) {
      wants.push(text.slice(5).split(' ')[0]);
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      shallowOids.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      depth = Number(text.slice(7).trim());
    }
    void first;
  }
  const plan = planFetch(repo, wants, haves, shallowOids, depth);
  const chunks: Buffer[] = [];
  chunks.push(encodePktLine('NAK\n'));
  for (const oid of plan.shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.oids.length > 0) {
    const objects = plan.oids.map((oid) => lookupObject(repo, oid)!).filter(Boolean);
    chunks.push(...sidebandPackets(writePack(objects, repo)), pktFlush());
  }
  chunks.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(chunks), 'application/x-git-upload-pack-result');
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const raw = await readBody(req);
  const lines = parsePktLines(raw);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const entry = lines[i];
    if (entry.kind === 'flush') {
      packStart = i + 1;
      break;
    }
    if (entry.kind !== 'line') continue;
    const text = entry.text.replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length >= 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2].split('\0')[0] });
    }
  }
  // The pack bytes follow the flush pkt-line in the raw body.
  let offset = 0;
  let seenFlush = false;
  while (offset + 4 <= raw.length) {
    const size = Number.parseInt(raw.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(size)) break;
    if (size === 0) {
      seenFlush = true;
      offset += 4;
      break;
    }
    if (size === 1) {
      offset += 4;
      continue;
    }
    offset += size;
  }
  void packStart;
  const packBytes = seenFlush ? raw.subarray(offset) : Buffer.alloc(0);
  let unpackOk = true;
  if (packBytes.length >= 4 && packBytes.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      const objects = readPack(packBytes, (oid) => lookupObject(repo, oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
      }
    } catch {
      unpackOk = false;
    }
  } else if (commands.some((c) => c.newOid !== ZERO_OID)) {
    unpackOk = false;
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    const target = lookupObject(repo, command.newOid);
    if (target === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    const isTagRef = command.ref.startsWith('refs/tags/');
    if (!isTagRef && target.type !== 'commit') {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!isTagRef && current !== undefined && current !== ZERO_OID) {
      const currentObject = lookupObject(repo, current);
      if (currentObject !== undefined && currentObject.type === 'commit' && !isAncestor(current, command.newOid, (oid) => lookupObject(repo, oid))) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    if (!repo.commitSeq.has(command.newOid)) repo.commitSeq.set(command.newOid, nextSeq());
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const chunks: Buffer[] = [];
  // report-status is a pkt-line stream carried inside sideband band 1: each report line is its
  // own pkt-line, the stream ends with a flush pkt-line, and the outer sideband framing ends
  // with a flush of its own.
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const reportStream = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), pktFlush()]);
  chunks.push(...sidebandPackets(reportStream), pktFlush());
  sendRaw(res, 200, Buffer.concat(chunks), 'application/x-git-receive-pack-result');
}

async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const segs = segments(path);
  // /{owner}/{repo}.git/info/refs | /{owner}/{repo}.git/git-upload-pack | /{owner}/{repo}.git/git-receive-pack
  if (segs.length < 3 || segs.length > 4) return false;
  const repoName = segs[1];
  if (!repoName.endsWith('.git')) return false;
  const owner = segs[0];
  const service = segs[2];
  const isInfoRefs = segs.length === 4 && service === 'info' && segs[3] === 'refs';
  const isUploadPack = segs.length === 3 && service === 'git-upload-pack';
  const isReceivePack = segs.length === 3 && service === 'git-receive-pack';
  if (!isInfoRefs && !isUploadPack && !isReceivePack) return false;
  const repo = getRepo(owner, repoName.slice(0, -'.git'.length));
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (method === 'GET' && isInfoRefs) {
    handleInfoRefs(req, res, repo);
    return true;
  }
  if (method === 'POST' && isUploadPack) {
    await handleUploadPack(req, res, repo);
    return true;
  }
  if (method === 'POST' && isReceivePack) {
    await handleReceivePack(req, res, repo);
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// ---------------------------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        if (path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (await handleGit(req, res)) return;
        if (await handleGraphql(req, res)) return;
        if (await handleMcp(req, res)) return;
        if (await handleRest(req, res)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        // Malformed input must never take the server down.
        try {
          sendJson(res, 400, { message: error instanceof Error ? error.message : 'Bad Request' });
        } catch {
          try {
            res.destroy();
          } catch {
            // ignore
          }
        }
      }
    })();
  });
}
