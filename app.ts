import { createServices, ApiError, treeFiles, writeCommit, required } from './surfaces.ts';
import { graphql } from './graphql.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { pktLine, flush, readPackets, generatePack, parsePack } from './pack.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export type GitObject = { type: ObjectType; data: Buffer };
const objectTypes = new Set<string>(['blob', 'tree', 'commit', 'tag']);

export function hashObject(type: ObjectType, data: Uint8Array | string): string {
  const bytes = Buffer.from(data);
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

export class GitObjectStore {
  objects = new Map<string, GitObject>();

  writeObject(type: ObjectType, data: Uint8Array | string): string {
    if (!objectTypes.has(type)) throw new Error('Invalid git object type');
    const bytes = Buffer.from(data);
    const id = hashObject(type, bytes);
    this.objects.set(id, { type, data: bytes });
    return id;
  }

  readObject(id: string): GitObject | undefined {
    const object = this.objects.get(id);
    return object && { type: object.type, data: Buffer.from(object.data) };
  }

  readLooseObject(id: string): Buffer | undefined {
    const object = this.objects.get(id);
    return object && deflateSync(Buffer.concat([
      Buffer.from(`${object.type} ${object.data.length}\0`), object.data,
    ]));
  }

  writeLooseObject(compressed: Uint8Array): string {
    const bytes = inflateSync(compressed);
    const end = bytes.indexOf(0);
    if (end < 0) throw new Error('Invalid loose object header');
    const match = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(bytes.subarray(0, end).toString());
    const data = bytes.subarray(end + 1);
    if (!match || Number(match[2]) !== data.length) throw new Error('Invalid loose object size or type');
    return this.writeObject(match[1] as ObjectType, data);
  }
}

export type Issue = {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
};
export type PullRequest = {
  id: number; number: number; title: string; body: string;
  head: string; base: string; state: 'open' | 'closed'; merged: boolean;
};
export type Repository = {
  id: number; owner: string; name: string; default_branch: string; private: boolean;
  issues: Map<number, Issue>; pulls: Map<number, PullRequest>; nextNumber: number;
  objects: GitObjectStore; refs: Map<string, string>;
};

export class ForgeStore {
  repositories = new Map<string, Repository>();
  nextRepositoryId = 1;
  nextIssueId = 1;
  nextPullRequestId = 1;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function readBody(request: IncomingMessage, batch = false): Promise<any> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(bytes);
  }
  try {
    const body = JSON.parse((chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)).toString('utf8'));
    if (!body || typeof body !== 'object' || (!batch && Array.isArray(body))) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

export function createApp(): Server {
  const store = new ForgeStore();
  const tipCache = new WeakMap<Repository, Map<string, { tip: string; ids: Set<string> }>>();
  type CachedPack = { pack: Buffer; ids: Set<string>; commits: Set<string> };
  const packCache = new WeakMap<Repository, Map<string, { tip: string; depths: Map<number, CachedPack | Promise<CachedPack>> }>>();
  const zero = '0'.repeat(40);
  const emptyArgs: Record<string, string> = Object.freeze({});
  function peelCommit(repo: Repository, id: string): string | undefined {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const object = repo.objects.objects.get(id);
      if (object?.type === 'commit') return id;
      if (object?.type !== 'tag') return undefined;
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString().split('\n\n', 1)[0]);
      if (!target) return undefined;
      id = target[1];
    }
    return undefined;
  }
  function parents(repo: Repository, id: string): string[] {
    const object = repo.objects.objects.get(id);
    return object?.type === 'commit' ? [...object.data.toString().split('\n\n', 1)[0].matchAll(/^parent ([0-9a-f]{40})$/gm)].map(m => m[1]) : [];
  }
  function ancestor(repo: Repository, old: string, tip: string): boolean {
    const pending = [tip], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === old) return true;
      if (seen.has(id)) continue;
      seen.add(id); pending.push(...parents(repo, id));
    }
    return false;
  }
  function treeObjects(repo: Repository, tip: string): Set<string> {
    const ids = new Set<string>();
    function visit(id: string) {
      if (ids.has(id)) return;
      const object = repo.objects.objects.get(id);
      if (!object) throw new HttpError(400, 'Missing object');
      ids.add(id);
      if (object.type === 'commit' || object.type === 'tag') {
        const target = /^(?:tree|object) ([0-9a-f]{40})$/m.exec(object.data.toString().split('\n\n', 1)[0]);
        if (target) visit(target[1]);
      } else if (object.type === 'tree') {
        let offset = 0;
        while (offset < object.data.length) {
          const space = object.data.indexOf(32, offset), end = object.data.indexOf(0, space);
          if (space < offset || end < space || end + 21 > object.data.length) throw new HttpError(400, 'Invalid tree');
          const mode = object.data.toString('ascii', offset, space);
          if (mode !== '160000') visit(object.data.subarray(end + 1, end + 21).toString('hex'));
          offset = end + 21;
        }
      }
    }
    visit(tip); return ids;
  }
  function tipObjects(repo: Repository, ref: string, tip: string): Set<string> {
    let cache = tipCache.get(repo);
    if (!cache) { cache = new Map(); tipCache.set(repo, cache); }
    const entry = cache.get(ref);
    if (entry?.tip === tip) return entry.ids;
    const ids = treeObjects(repo, tip); cache.set(ref, { tip, ids }); return ids;
  }
  let requestId = 0;
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const authorization = `Bearer ${token}`;
  let viewerLogin: string | undefined;
  const login = () => viewerLogin ?? token ?? '';
  function bindViewer(owner: string): boolean {
    if (viewerLogin === undefined) {
      viewerLogin = owner;
      for (const repo of store.repositories.values()) repo.owner = owner;
    }
    return owner === viewerLogin;
  }
  const services = createServices(store, login, bindViewer, body => {
    const name = required(body.name, 'Name');
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new ApiError(422, 'Invalid repository name');
    if (body.private !== undefined && typeof body.private !== 'boolean') throw new ApiError(422, 'Invalid private flag');
    const key = name;
    if (store.repositories.has(key)) throw new ApiError(422, 'Repository already exists');
    const repo: Repository = { id: store.nextRepositoryId++, owner: login(), name, default_branch: 'main', private: body.private === true, issues: new Map(), pulls: new Map(), nextNumber: 1, objects: new GitObjectStore(), refs: new Map() };
    store.repositories.set(key, repo); return repo;
  });
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-GitHub-Request-Id', String(++requestId));
    const send = (status: number, body: unknown) => {
      response.statusCode = status;
      response.end(JSON.stringify(body));
    };
    async function route() {
      const rawUrl = request.url ?? '/';
      const queryStart = rawUrl.indexOf('?');
      const fragmentStart = rawUrl.indexOf('#');
      const pathEnd = Math.min(queryStart < 0 ? rawUrl.length : queryStart, fragmentStart < 0 ? rawUrl.length : fragmentStart);
      let path = rawUrl.slice(0, pathEnd);
      // Preserve URL normalization for unusual request targets without allocating on ordinary paths.
      if (!path.startsWith('/') || path.startsWith('//') || /[\\\s\x00-\x20\x7f-\uffff]|(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(path)) path = new URL(rawUrl, 'http://localhost').pathname;
      const query = queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart) ? '' : rawUrl.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
      const method = request.method;
      if (path === '/healthz' && method === 'GET') { send(200, { ok: true }); return; }
      if (!token || request.headers.authorization !== authorization) {
        send(401, { message: 'Bad credentials' });
        return;
      }
      const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (git) {
        let owner: string, name: string;
        try { owner = decodeURIComponent(git[1]); name = decodeURIComponent(git[2]); }
        catch { throw new HttpError(400, 'Invalid path encoding'); }
        const repo = bindViewer(owner) ? store.repositories.get(name) : undefined;
        if (!repo) throw new HttpError(404, 'Not Found');
        const head = `refs/heads/${repo.default_branch}`;
        repo.refs.set('HEAD', head);
        const refs = [...repo.refs].filter(([ref]) => ref.startsWith('refs/'));
        const v2 = String(request.headers['git-protocol'] ?? '').split(':').includes('version=2');
        const reply = (service: string, kind: string, data: Buffer) => {
          response.setHeader('Content-Type', `application/x-${service}-${kind}`);
          response.setHeader('Cache-Control', 'no-cache'); response.end(data);
        };
        const sideband = (pack: Buffer) => {
          const chunks: Buffer[] = [];
          for (let i = 0; i < pack.length; i += 65515) chunks.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + 65515)])));
          return Buffer.concat([...chunks, flush]);
        };
        if (method === 'GET' && git[3] === 'info/refs') {
          const service = new URLSearchParams(query).get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'Invalid service');
          if (v2 && service === 'git-upload-pack') {
            reply(service, 'advertisement', Buffer.concat(['version 2\n', 'agent=makefun\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pktLine).concat([flush])));
          } else {
            const caps = service === 'git-upload-pack' ? `multi_ack_detailed side-band-64k ofs-delta shallow no-progress symref=HEAD:${head}` : 'report-status side-band-64k delete-refs ofs-delta';
            const advertised: [string, string][] = repo.refs.get(head) ? [['HEAD', repo.refs.get(head)!], ...refs] : refs;
            const lines = advertised.length ? advertised.map(([ref, id], i) => pktLine(`${id} ${ref}${i === 0 ? `\0${caps}` : ''}\n`)) : [pktLine(`${zero} capabilities^{}\0${caps}\n`)];
            reply(service, 'advertisement', Buffer.concat([pktLine(`# service=${service}\n`), flush, ...lines, flush]));
          }
          return;
        }
        if (method === 'POST' && git[3] !== 'info/refs') {
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of request) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length;
            if (length > 256 * 1024 * 1024) throw new HttpError(413, 'Request body too large');
            chunks.push(bytes);
          }
          const body = Buffer.concat(chunks), decoded = readPackets(body);
          const lines = decoded.packets.map(p => p.toString());
          if (git[3] === 'git-upload-pack') {
            if (v2 && lines.some(line => line.trim() === 'command=ls-refs')) {
              const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice(11).trim());
              const advertised: [string, string][] = repo.refs.get(head) ? [['HEAD', repo.refs.get(head)!], ...refs] : refs;
              reply('git-upload-pack', 'result', Buffer.concat([...advertised.filter(([ref]) => !prefixes.length || prefixes.some(p => ref.startsWith(p))).map(([ref, id]) => {
                let peeled = id;
                const seen = new Set<string>();
                while (repo.objects.objects.get(peeled)?.type === 'tag' && !seen.has(peeled)) {
                  seen.add(peeled);
                  const target = /^object ([0-9a-f]{40})$/m.exec(repo.objects.objects.get(peeled)!.data.toString().split('\n\n', 1)[0]);
                  if (!target) break;
                  peeled = target[1];
                }
                return pktLine(`${id} ${ref}${ref === 'HEAD' ? ` symref-target:${head}` : ''}${peeled !== id && repo.objects.objects.get(peeled)?.type !== 'tag' ? ` peeled:${peeled}` : ''}\n`);
              }), flush]));
              return;
            }
            const wants = lines.flatMap(l => { const m = /^want ([0-9a-f]{40})(?:\s|$)/.exec(l); return m ? [m[1]] : []; });
            if (!wants.length) throw new HttpError(400, 'Missing wants');
            const haves = lines.flatMap(l => { const m = /^have ([0-9a-f]{40})(?:\s|$)/.exec(l); return m ? [m[1]] : []; });
            const clientShallow = new Set(lines.flatMap(l => { const m = /^shallow ([0-9a-f]{40})\s*$/.exec(l); return m ? [m[1]] : []; }));
            const deepen = lines.map(l => /^deepen ([1-9][0-9]*)\s*$/.exec(l)).find(Boolean);
            const depth = deepen ? Number(deepen[1]) : Infinity;
            function walk(roots: string[], limit: number, stops = new Set<string>()) {
              const ids = new Set<string>(), commits = new Set<string>(), seen = new Set<string>();
              const pending = roots.map(id => ({ id, generation: 1 }));
              for (let i = 0; i < pending.length; i++) {
                const { id, generation } = pending[i];
                if (seen.has(id)) continue;
                seen.add(id);
                const object = repo.objects.objects.get(id);
                if (!object) continue;
                const ref = refs.find(([, tip]) => tip === id)?.[0];
                for (const child of ref ? tipObjects(repo, ref, id) : treeObjects(repo, id)) ids.add(child);
                if (object.type === 'tag') {
                  const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString().split('\n\n', 1)[0]);
                  if (target) pending.push({ id: target[1], generation });
                } else if (object.type === 'commit') {
                  commits.add(id);
                  if (generation < limit && !stops.has(id)) for (const parent of parents(repo, id)) pending.push({ id: parent, generation: generation + 1 });
                }
              }
              return { ids, commits };
            }
            const cacheRef = deepen && wants.length === 1 && !haves.length && !clientShallow.size ? refs.find(([, tip]) => tip === wants[0])?.[0] : undefined;
            let depths: Map<number, CachedPack | Promise<CachedPack>> | undefined;
            if (cacheRef) {
              let cache = packCache.get(repo);
              if (!cache) { cache = new Map(); packCache.set(repo, cache); }
              let entry = cache.get(cacheRef);
              if (entry?.tip !== wants[0]) { entry = { tip: wants[0], depths: new Map() }; cache.set(cacheRef, entry); }
              depths = entry.depths;
            }
            let cached = depths?.get(depth);
            if (depths && !cached) {
              const pending = Promise.resolve().then(() => {
                const wanted = walk(wants, depth);
                const pack = generatePack([...wanted.ids].map(id => repo.objects.objects.get(id)!));
                return { pack, ids: wanted.ids, commits: wanted.commits };
              });
              depths.set(depth, pending);
              cached = pending;
              try {
                const resolved = await pending;
                if (depths.get(depth) === pending) depths.set(depth, resolved);
                cached = resolved;
              } catch (error) {
                if (depths.get(depth) === pending) depths.delete(depth);
                throw error;
              }
            }
            const resolved = cached instanceof Promise ? await cached : cached;
            const held = walk(haves, Infinity, clientShallow);
            const wanted = resolved ?? walk(wants, depth);
            const pack = resolved?.pack ?? generatePack([...wanted.ids].filter(id => !held.ids.has(id)).map(id => repo.objects.objects.get(id)!));
            const available = new Set([...held.ids, ...wanted.ids]);
            const shallowLines = deepen ? [
              ...[...wanted.commits].filter(id => parents(repo, id).some(parent => !available.has(parent))).map(id => pktLine(`shallow ${id}\n`)),
              ...haves.filter((id, i) => haves.indexOf(id) === i && clientShallow.has(id) && wanted.commits.has(id) && parents(repo, id).every(parent => available.has(parent))).map(id => pktLine(`unshallow ${id}\n`)),
            ] : [];
            if (v2) {
              reply('git-upload-pack', 'result', Buffer.concat([...(deepen ? [pktLine('shallow-info\n'), ...shallowLines, Buffer.from('0001')] : []), pktLine('packfile\n'), sideband(pack)]));
            } else {
              const band = lines.some(l => /\bside-band(?:-64k)?\b/.test(l));
              reply('git-upload-pack', 'result', Buffer.concat([...shallowLines, ...(deepen ? [flush] : []), pktLine('NAK\n'), band ? sideband(pack) : pack]));
            }
            return;
          }
          const commands = lines.filter(Boolean);
          const capabilities = commands[0]?.split('\0')[1] ?? '';
          let unpack = 'ok';
          try {
            if (decoded.offset < body.length) for (const [id, object] of parsePack(body.subarray(decoded.offset), repo.objects.objects)) repo.objects.objects.set(id, object);
          } catch { unpack = 'invalid pack'; }
          const reports = [pktLine(`unpack ${unpack}\n`)];
          for (const command of commands) {
            const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\0]+)(?:\0.*)?\n?$/.exec(command);
            if (!match) throw new HttpError(400, 'Invalid ref update');
            const [, old, next, ref] = match;
            const current = repo.refs.get(ref) ?? zero;
            let reason = unpack !== 'ok' ? 'unpacker error' : current !== old ? 'stale old id' : '';
            const nextType = repo.objects.objects.get(next)?.type;
            if (!reason && next !== zero && nextType !== 'commit' && nextType !== 'tag') reason = 'missing commit';
            if (!reason && old !== zero && next !== zero) {
              const oldCommit = peelCommit(repo, old), nextCommit = peelCommit(repo, next);
              if (!oldCommit || !nextCommit || !ancestor(repo, oldCommit, nextCommit)) reason = 'non-fast-forward';
            }
            if (!reason) {
              if (next === zero) repo.refs.delete(ref); else repo.refs.set(ref, next);
              tipCache.get(repo)?.delete(ref);
              packCache.get(repo)?.delete(ref);
            }
            reports.push(pktLine(reason ? `ng ${ref} ${reason}\n` : `ok ${ref}\n`));
          }
          const report = Buffer.concat([...reports, flush]);
          reply('git-receive-pack', 'result', capabilities.includes('side-band-64k') ? sideband(report) : report);
          return;
        }
        throw new HttpError(404, 'Not Found');
      }
      if (path === '/api/graphql' && method === 'POST') { send(200, graphql(services, await readBody(request, true))); return; }
      if (path === '/mcp' && method === 'POST') {
        let body;
        try { body = await readBody(request); }
        catch { send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        const result = services.mcp(body);
        if (result === null) { send(202, {}); return; }
        send(200, result); return;
      }
      if ((path === '/api/v3/' || path === '/api/v3') && method === 'GET') { response.setHeader('X-OAuth-Scopes', 'repo, read:org'); send(200, {}); return; }
      if (path === '/api/v3/meta' && method === 'GET') { send(200, { installed_version: '1.0.0' }); return; }
      if (path === '/api/v3/user' && method === 'GET') { send(200, { login: login() }); return; }
      if (path === '/api/v3/user/repos') {
        if (method === 'POST') { send(201, services.newRepo(await readBody(request))); return; }
        if (method === 'GET') {
          const all = [...store.repositories.values()];
          const searchParams = new URLSearchParams(query);
          const size = Math.max(1, Math.min(100, Number(searchParams.get('per_page') ?? 30) || 30));
          const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1);
          if (page * size < all.length) {
            const next = new URL(request.url!, `http://${request.headers.host ?? 'localhost'}`);
            next.searchParams.set('page', String(page + 1)); next.searchParams.set('per_page', String(size));
            response.setHeader('Link', `<${next}>; rel="next"`);
          }
          send(200, all.slice((page - 1) * size, page * size).map(services.repoJSON)); return;
        }
      }
      const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (match) {
        let owner: string, name: string, tail: string;
        try { owner = decodeURIComponent(match[1]); name = decodeURIComponent(match[2]); tail = decodeURIComponent(match[3] ?? ''); }
        catch { throw new HttpError(400, 'Invalid path encoding'); }
        const repo = services.getRepo(owner, name);
        const args = query ? Object.fromEntries(new URLSearchParams(query)) : emptyArgs;
        if (!tail) {
          if (method === 'GET') { send(200, services.repoJSON(repo)); return; }
          if (method === 'DELETE') { store.repositories.delete(name); send(204, null); return; }
          if (method === 'PATCH') {
            const body = await readBody(request);
            if (body.description !== undefined) services.descriptions.set(repo, String(body.description));
            if (body.default_branch !== undefined) repo.default_branch = required(body.default_branch, 'Default branch');
            if (typeof body.private === 'boolean') repo.private = body.private;
            send(200, services.repoJSON(repo)); return;
          }
        }
        if (tail === 'git/refs' && method === 'POST') {
          const body = await readBody(request), ref = required(body.ref, 'Ref'), sha = required(body.sha, 'Sha');
          if (!ref.startsWith('refs/heads/') || !repo.objects.objects.has(sha) || repo.refs.has(ref)) throw new ApiError(422, 'Invalid ref');
          repo.refs.set(ref, sha); send(201, { ref, object: { sha } }); return;
        }
        if (tail.startsWith('git/refs/heads/') && method === 'GET') {
          const ref = tail.slice(4), sha = repo.refs.get(ref); if (!sha) throw new ApiError(404, 'Not Found');
          send(200, { ref, object: { sha } }); return;
        }
        if (tail === 'branches' && method === 'GET') {
          send(200, [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } }))); return;
        }
        if (tail === 'commits' && method === 'GET') {
          const pending = [repo.refs.get(`refs/heads/${args.sha ?? repo.default_branch}`) ?? args.sha], seen = new Set<string>(), commits = [];
          while (pending.length) {
            const sha = pending.shift(); if (!sha || seen.has(sha)) continue; seen.add(sha);
            const object = repo.objects.objects.get(sha); if (object?.type !== 'commit') continue;
            commits.push({ sha, commit: { message: object.data.toString().split('\n\n').slice(1).join('\n\n').replace(/\n$/, '') } }); pending.push(...parents(repo, sha));
          }
          send(200, commits); return;
        }
        if (tail === 'contents' || tail.startsWith('contents/')) {
          const filePath = tail.slice(9).replace(/^\/+|\/+$/g, '');
          const body = method === 'GET' ? {} : await readBody(request);
          const branch = body.branch ?? args.ref ?? repo.default_branch;
          const tip = repo.refs.get(`refs/heads/${branch}`) ?? (repo.objects.objects.has(branch) ? branch : undefined);
          const files = treeFiles(repo, tip), old = files.get(filePath);
          const entry = (path: string, sha: string) => {
            const data = repo.objects.objects.get(sha)?.data ?? Buffer.alloc(0);
            return { type: 'file', name: path.split('/').at(-1), path, sha, size: data.length, encoding: 'base64', content: data.toString('base64') };
          };
          if (method === 'GET') {
            if (old) { send(200, entry(filePath, old)); return; }
            const prefix = filePath ? `${filePath}/` : '', entries = new Map<string, unknown>();
            for (const [path, sha] of files) if (path.startsWith(prefix)) {
              const rest = path.slice(prefix.length), slash = rest.indexOf('/');
              if (slash < 0) entries.set(rest, entry(path, sha));
              else { const name = rest.slice(0, slash); entries.set(name, { type: 'dir', name, path: prefix + name }); }
            }
            if (!entries.size) throw new ApiError(404, 'Not Found');
            send(200, [...entries.values()]); return;
          }
          if (method === 'PUT' || method === 'DELETE') {
            if (!filePath || filePath.split('/').some(p => p === '..' || p === '.')) throw new ApiError(422, 'Invalid path');
            if (method === 'DELETE' && !old) throw new ApiError(404, 'Not Found');
            if ((old && body.sha !== old) || (!old && body.sha !== undefined)) throw new ApiError(409, 'SHA does not match');
            let sha = '';
            if (method === 'DELETE') files.delete(filePath);
            else { if (typeof body.content !== 'string') throw new ApiError(422, 'Content is required'); sha = repo.objects.writeObject('blob', Buffer.from(body.content, 'base64')); files.set(filePath, sha); }
            const commit = writeCommit(repo, files, tip, required(body.message, 'Message'));
            repo.refs.set(`refs/heads/${branch}`, commit);
            send(method === 'PUT' && !old ? 201 : 200, { content: method === 'DELETE' ? null : entry(filePath, sha), commit: { sha: commit } }); return;
          }
        }
        if (tail === 'labels' && method === 'POST') {
          const body = await readBody(request), name = required(body.name, 'Name');
          let labels = services.labels.get(repo); if (!labels) { labels = new Map(); services.labels.set(repo, labels); }
          const label = { name, color: body.color ?? 'ededed' }; labels.set(name, label); send(201, label); return;
        }
        const issue = /^issues(?:\/(\d+))?(?:\/(comments))?$/.exec(tail);
        if (issue) {
          if (!issue[1]) {
            if (method === 'POST') { send(201, services.newIssue(repo, await readBody(request))); return; }
            if (method === 'GET') { send(200, services.listIssues(repo, args)); return; }
          } else {
            const subject = services.item(repo.issues, issue[1]);
            if (issue[2]) {
              if (method === 'POST') { send(201, services.comment(subject, await readBody(request))); return; }
              if (method === 'GET') { send(200, services.comments.get(subject) ?? []); return; }
            } else {
              if (method === 'GET') { send(200, subject); return; }
              if (method === 'PATCH') { send(200, services.update(subject, await readBody(request))); return; }
            }
          }
        }
        const pull = /^pulls(?:\/(\d+))?(?:\/(merge|files))?$/.exec(tail);
        if (pull) {
          if (!pull[1]) {
            if (method === 'POST') { send(201, services.pullJSON(repo, services.newPull(repo, await readBody(request)))); return; }
            if (method === 'GET') { send(200, [...repo.pulls.values()].filter(p => args.state === 'all' || p.state === (args.state ?? 'open')).map(p => services.pullJSON(repo, p))); return; }
          } else {
            const subject = services.item(repo.pulls, pull[1]);
            if (pull[2] === 'merge' && (method === 'PUT' || method === 'POST')) { await readBody(request); send(200, services.merge(repo, subject)); return; }
            if (pull[2] === 'files' && method === 'GET') { send(200, services.changes(repo, subject)); return; }
            if (!pull[2] && method === 'GET') { send(200, services.pullJSON(repo, subject)); return; }
            if (!pull[2] && method === 'PATCH') { services.update(subject, await readBody(request)); send(200, services.pullJSON(repo, subject)); return; }
          }
        }
      }
      throw new HttpError(404, 'Not Found');
    }
    route().catch(error => {
      if (!response.headersSent) send((error instanceof HttpError || error instanceof ApiError) ? error.status : 500, {
        message: (error instanceof HttpError || error instanceof ApiError) ? error.message : 'Internal Server Error',
      });
      else response.destroy();
    });
  });
}
