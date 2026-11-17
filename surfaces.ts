import type { ForgeStore, Repository, Issue, PullRequest } from './app.ts';

type Args = Record<string, any>;
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(422, `${name} is required`);
  return value;
}
export function treeFiles(repo: Repository, commit?: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!commit) return files;
  const object = repo.objects.objects.get(commit);
  const tree = object?.type === 'tree' ? commit : /^tree ([0-9a-f]{40})$/m.exec(object?.data.toString() ?? '')?.[1];
  function walk(id: string, prefix: string) {
    const data = repo.objects.objects.get(id)?.data;
    if (!data) return;
    let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(32, offset), end = data.indexOf(0, space);
      if (space < offset || end < space || end + 21 > data.length) throw new ApiError(400, 'Invalid tree');
      const mode = data.toString('ascii', offset, space), name = data.toString('utf8', space + 1, end);
      const sha = data.subarray(end + 1, end + 21).toString('hex');
      if (mode === '40000' || mode === '040000') walk(sha, `${prefix}${name}/`);
      else files.set(`${prefix}${name}`, sha);
      offset = end + 21;
    }
  }
  if (tree) walk(tree, '');
  return files;
}
export function writeCommit(repo: Repository, files: Map<string, string>, parent: string | undefined, message: string): string {
  function tree(prefix: string): string {
    const entries = new Map<string, { mode: string; sha: string }>();
    for (const [path, sha] of files) {
      if (!path.startsWith(prefix)) continue;
      const tail = path.slice(prefix.length), slash = tail.indexOf('/');
      if (slash < 0) entries.set(tail, { mode: '100644', sha });
      else {
        const name = tail.slice(0, slash);
        if (!entries.has(name)) entries.set(name, { mode: '40000', sha: tree(`${prefix}${name}/`) });
      }
    }
    return repo.objects.writeObject('tree', Buffer.concat([...entries].sort(([a, av], [b, bv]) => Buffer.compare(Buffer.from(a + (av.mode === '40000' ? '/' : '')), Buffer.from(b + (bv.mode === '40000' ? '/' : '')))).map(([name, e]) => Buffer.concat([Buffer.from(`${e.mode} ${name}\0`), Buffer.from(e.sha, 'hex')]))));
  }
  return repo.objects.writeObject('commit', `tree ${tree('')}\n${parent ? `parent ${parent}\n` : ''}author Makefun <forge@make.fun> 1700000000 +0000\ncommitter Makefun <forge@make.fun> 1700000000 +0000\n\n${message}\n`);
}
export function createServices(store: ForgeStore, login: () => string, bindViewer: (owner: string) => boolean, createRepo: (body: Args) => Repository) {
  let commentId = 1;
  const comments = new Map<Issue | PullRequest, Args[]>();
  const labels = new WeakMap<Repository, Map<string, Args>>();
  const pullTips = new WeakMap<PullRequest, { head: string; base: string }>();
  const mergeShas = new WeakMap<PullRequest, string>();
  const descriptions = new WeakMap<Repository, string>();
  function getRepo(owner: string, name: string) {
    const repo = bindViewer(owner) ? store.repositories.get(name) : undefined;
    if (!repo) throw new ApiError(404, 'Not Found');
    return repo;
  }
  function repoJSON(repo: Repository) {
    return { id: repo.id, node_id: `Repository:${repo.id}`, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, private: repo.private, visibility: repo.private ? 'private' : 'public', default_branch: repo.default_branch, description: descriptions.get(repo) ?? '' };
  }
  function newRepo(body: Args) { const repo = createRepo(body); descriptions.set(repo, typeof body.description === 'string' ? body.description : ''); return repoJSON(repo); }
  function newIssue(repo: Repository, body: Args) {
    const title = required(body.title, 'Title');
    if (body.body != null && typeof body.body !== 'string') throw new ApiError(422, 'Invalid body');
    if (body.labels !== undefined && (!Array.isArray(body.labels) || body.labels.some((x: unknown) => typeof x !== 'string' || !labels.get(repo)?.has(x)))) throw new ApiError(422, 'Unknown label');
    const issue = { id: store.nextIssueId++, number: repo.nextNumber++, title, body: body.body ?? '', state: 'open' as const, labels: (body.labels ?? []).map((name: string) => labels.get(repo)!.get(name)) };
    repo.issues.set(issue.number, issue); return issue;
  }
  function listIssues(repo: Repository, args: Args) {
    const state = args.state ?? 'open';
    if (!['all', 'open', 'closed'].includes(state)) throw new ApiError(422, 'Invalid issue state');
    return [...repo.issues.values()].filter(i => state === 'all' || i.state === state).sort((a, b) => args.direction === 'asc' ? a.number - b.number : b.number - a.number);
  }
  function newPull(repo: Repository, body: Args) {
    const title = required(body.title, 'Title'), head = required(body.head, 'Head').replace(`${repo.owner}:`, ''), base = required(body.base, 'Base');
    const headTip = repo.refs.get(`refs/heads/${head}`), baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip || !baseTip) throw new ApiError(422, 'Unknown head or base branch');
    const pull: PullRequest = { id: store.nextPullRequestId++, number: repo.nextNumber++, title, body: body.body ?? '', head, base, state: 'open', merged: false };
    pullTips.set(pull, { head: headTip, base: baseTip }); repo.pulls.set(pull.number, pull); return pull;
  }
  function pullJSON(repo: Repository, pull: PullRequest) {
    const tips = pullTips.get(pull)!;
    return { ...pull, node_id: `PullRequest:${pull.id}`, head: { ref: pull.head, sha: tips.head }, base: { ref: pull.base, sha: tips.base }, merged_at: pull.merged ? '2023-11-14T22:13:20Z' : null, merge_commit_sha: mergeShas.get(pull) ?? null };
  }
  function changes(repo: Repository, pull: PullRequest) {
    const tips = pullTips.get(pull)!;
    const base = treeFiles(repo, tips.base), head = treeFiles(repo, tips.head);
    return [...new Set([...base.keys(), ...head.keys()])].sort().filter(path => base.get(path) !== head.get(path)).map(path => {
      const lines = (sha?: string) => sha ? (repo.objects.objects.get(sha)?.data.toString().split('\n').filter(Boolean).length ?? 0) : 0;
      const additions = lines(head.get(path)), deletions = lines(base.get(path));
      return { filename: path, status: !base.has(path) ? 'added' : !head.has(path) ? 'removed' : 'modified', additions, deletions, changes: additions + deletions };
    });
  }
  function merge(repo: Repository, pull: PullRequest) {
    if (pull.state !== 'open') throw new ApiError(405, 'Pull request is not open');
    const tips = pullTips.get(pull)!, original = treeFiles(repo, tips.base), head = treeFiles(repo, tips.head);
    const parent = repo.refs.get(`refs/heads/${pull.base}`), current = treeFiles(repo, parent);
    for (const { filename } of changes(repo, pull)) {
      if (current.get(filename) !== original.get(filename) && current.get(filename) !== head.get(filename)) throw new ApiError(405, 'Pull request has conflicts');
      if (head.has(filename)) current.set(filename, head.get(filename)!); else current.delete(filename);
    }
    const sha = writeCommit(repo, current, parent, pull.title);
    repo.refs.set(`refs/heads/${pull.base}`, sha); pull.state = 'closed'; pull.merged = true; mergeShas.set(pull, sha);
    return { sha, merged: true, message: 'Pull request successfully merged' };
  }
  function comment(subject: Issue | PullRequest, body: Args) {
    const entry = { id: commentId++, body: required(body.body, 'Body') };
    const list = comments.get(subject) ?? []; list.push(entry); comments.set(subject, list); return entry;
  }
  function item<T>(map: Map<number, T>, number: unknown): T { const value = map.get(Number(number)); if (!value) throw new ApiError(404, 'Not Found'); return value; }
  function update(subject: Issue | PullRequest, body: Args) {
    if (body.title !== undefined) required(body.title, 'Title');
    if (body.body !== undefined && typeof body.body !== 'string') throw new ApiError(422, 'Invalid body');
    if (body.state !== undefined && !['open', 'closed'].includes(body.state)) throw new ApiError(422, 'Invalid state');
    for (const key of ['title', 'body', 'state'] as const) if (body[key] !== undefined) (subject as any)[key] = body[key];
    return subject;
  }
  const tools = [
    ['create_repo', ['name'], ['name', 'description', 'private']],
    ['get_repo', ['owner', 'repo'], ['owner', 'repo']],
    ['create_issue', ['owner', 'repo', 'title'], ['owner', 'repo', 'title', 'body']],
    ['list_issues', ['owner', 'repo'], ['owner', 'repo', 'state']],
    ['create_pull_request', ['owner', 'repo', 'title', 'head', 'base'], ['owner', 'repo', 'title', 'head', 'base', 'body']],
    ['merge_pull_request', ['owner', 'repo', 'pull_number'], ['owner', 'repo', 'pull_number']],
  ].map(([name, required, properties]) => ({ name, description: `GitHub forge ${String(name).replaceAll('_', ' ')}.`, inputSchema: { type: 'object', required, properties: Object.fromEntries((properties as string[]).map(p => [p, { type: p === 'private' ? 'boolean' : p === 'pull_number' ? 'integer' : 'string' }])) } }));
  function mcp(body: Args) {
    const id = body.id ?? null;
    const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    const identity = { serverInfo: { name: 'makefun-forge', version: '1.0.0' }, capabilities: { tools: {} }, supportedVersions: ['2026-07-28', '2025-11-25'] };
    let result: unknown;
    if (body.method === 'server/discover') result = identity;
    else if (body.method === 'initialize') result = { ...identity, protocolVersion: '2025-11-25' };
    else if (body.method === 'notifications/initialized') return null;
    else if (body.method === 'ping') result = {};
    else if (body.method === 'tools/list') result = { tools };
    else if (body.method === 'tools/call') {
      const tool = tools.find(t => t.name === body.params?.name);
      if (!tool) return error(-32602, 'Unknown tool');
      const args = body.params?.arguments;
      if (args && typeof args.owner === 'string' && !bindViewer(args.owner)) throw new ApiError(404, 'Not Found');
      if (!args || typeof args !== 'object' || (tool.inputSchema.required as string[]).some(p => args[p] === undefined || args[p] === null || args[p] === '')) return error(-32602, 'Missing required argument');
      try {
        let value: unknown;
        if (tool.name === 'create_repo') value = newRepo(args);
        else {
          const repo = getRepo(args.owner, args.repo);
          if (tool.name === 'get_repo') value = repoJSON(repo);
          if (tool.name === 'create_issue') value = newIssue(repo, args);
          if (tool.name === 'list_issues') value = listIssues(repo, args);
          if (tool.name === 'create_pull_request') value = pullJSON(repo, newPull(repo, args));
          if (tool.name === 'merge_pull_request') value = merge(repo, item(repo.pulls, args.pull_number));
        }
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (e) { result = { isError: true, content: [{ type: 'text', text: (e as Error).message }] }; }
    } else return error(-32601, 'Method not found');
    return { jsonrpc: '2.0', id, result };
  }
  return { getRepo, repoJSON, newRepo, newIssue, listIssues, newPull, pullJSON, changes, merge, comment, comments, item, update, labels, descriptions, mcp, store, bindViewer, get login() { return login(); } };
}
export type Services = ReturnType<typeof createServices>;
