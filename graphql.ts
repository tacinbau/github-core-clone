import type { Services } from './surfaces.ts';
import { ApiError } from './surfaces.ts';
import type { Repository, Issue, PullRequest } from './app.ts';

type Field = { name: string; alias: string; args: Record<string, any>; fields: Field[] };
const schema: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: ['ISSUE', 'REPOSITORY'],
};
function parse(query: string, variables: Record<string, any>): Field[] {
  const tokens = query.match(/\.\.\.|\$[A-Za-z_]\w*|[A-Za-z_]\w*|"(?:\\.|[^"\\])*"|-?\d+|[^\s,#]/g) ?? [];
  let p = 0;
  function value(): any {
    const token = tokens[p++];
    if (token === '{') { const out: Record<string, any> = {}; while (tokens[p] !== '}') { const key = tokens[p++]; if (tokens[p++] !== ':') throw new Error('Invalid input'); out[key] = value(); } p++; return out; }
    if (token === '[') { const out = []; while (tokens[p] !== ']') out.push(value()); p++; return out; }
    if (token?.startsWith('$')) return variables[token.slice(1)];
    if (token?.startsWith('"')) return JSON.parse(token);
    if (/^-?\d+$/.test(token)) return Number(token);
    if (token === 'null') return null;
    return token;
  }
  function fields(): Field[] {
    if (tokens[p++] !== '{') throw new Error('Expected selection');
    const out: Field[] = [];
    while (p < tokens.length && tokens[p] !== '}') {
      if (tokens[p] === '...') { p += 3; out.push(...fields()); continue; }
      let name = tokens[p++], alias = name;
      if (tokens[p] === ':') { p++; name = tokens[p++]; }
      const args: Record<string, any> = {};
      if (tokens[p] === '(') {
        p++;
        while (tokens[p] !== ')' && p < tokens.length) { const key = tokens[p++]; if (tokens[p++] !== ':') throw new Error('Invalid arguments'); args[key] = value(); }
        p++;
      }
      const children = tokens[p] === '{' ? fields() : [];
      out.push({ name, alias, args, fields: children });
    }
    if (tokens[p++] !== '}') throw new Error('Unclosed selection');
    return out;
  }
  if (tokens[p] !== '{') {
    while (p < tokens.length && tokens[p] !== '(' && tokens[p] !== '{') p++;
    if (tokens[p] === '(') { let depth = 1; p++; while (p < tokens.length && depth) { if (tokens[p] === '(') depth++; if (tokens[p] === ')') depth--; p++; } }
  }
  return fields();
}
export function graphql(s: Services, body: any): any {
  if (Array.isArray(body)) return body.map(b => graphql(s, b));
  try {
    if (typeof body?.query !== 'string') throw new Error('Query is required');
    const fields = parse(body.query, body.variables ?? {});
    function bindOwners(selection: Field[]) {
      for (const field of selection) {
        if (field.name === 'repository' && typeof field.args.owner === 'string' && !s.bindViewer(field.args.owner)) throw new ApiError(404, 'Not Found');
        bindOwners(field.fields);
      }
    }
    bindOwners(fields);
    const repositoryById = (id: string) => [...s.store.repositories.values()].find(r => `Repository:${r.id}` === id);
    function findSubject(id: string): { repo: Repository; subject: Issue | PullRequest; type: string } {
      for (const repo of s.store.repositories.values()) for (const [type, values] of [['Issue', repo.issues], ['PullRequest', repo.pulls]] as const) {
        for (const subject of values.values()) if (`${type}:${subject.id}` === id) return { repo, subject, type };
      }
      throw new Error('Unknown node id');
    }
    const wrap = (type: string, value: any, repo?: Repository) => value == null ? null : { type, value, repo };
    function connection(type: string, values: any[], args: any, repo?: Repository) {
      const start = args.after ? Number(Buffer.from(args.after, 'base64').toString()) : 0;
      const end = start + Math.max(0, args.first ?? values.length);
      return { nodes: values.slice(start, end).map(v => wrap(type, v, repo)), pageInfo: { hasNextPage: end < values.length, endCursor: values.slice(start, end).length ? Buffer.from(String(Math.min(end, values.length))).toString('base64') : null } };
    }
    function resolve(type: string, value: any, repo: Repository | undefined, field: Field): any {
      const a = field.args, name = field.name;
      if (name === '__typename') return type;
      if (type === 'Query') {
        if (name === 'viewer') return wrap('User', { login: s.login });
        if (name === '__type') return schema[a.name] ? { fields: schema[a.name].map(name => ({ name })), enumValues: schema[a.name].map(name => ({ name })) } : null;
        if (name === 'repository') { try { const r = s.getRepo(a.owner, a.name); return wrap('Repository', r, r); } catch { return null; } }
        if (name === 'node') { const r = repositoryById(a.id); if (r) return wrap('Repository', r, r); const found = findSubject(a.id); return wrap(found.type, found.subject, found.repo); }
        const input = a.input ?? {};
        if (name === 'createIssue' || name === 'createPullRequest') {
          const r = repositoryById(input.repositoryId); if (!r) throw new Error('Unknown repository id');
          return name === 'createIssue' ? { issue: wrap('Issue', s.newIssue(r, input), r) } : { pullRequest: wrap('PullRequest', s.newPull(r, { ...input, head: input.headRefName, base: input.baseRefName }), r) };
        }
        if (['closeIssue', 'mergePullRequest', 'addComment'].includes(name)) {
          const found = findSubject(input.issueId ?? input.pullRequestId ?? input.subjectId);
          if (name === 'closeIssue') { found.subject.state = 'closed'; return { issue: wrap('Issue', found.subject, found.repo) }; }
          if (name === 'mergePullRequest') { s.merge(found.repo, found.subject as PullRequest); return { pullRequest: wrap('PullRequest', found.subject, found.repo) }; }
          const c = s.comment(found.subject, input); return { commentEdge: { node: { ...c, id: `Comment:${c.id}` } } };
        }
      } else if (type === 'Repository') {
        const r = value as Repository;
        if (name === 'id') return `Repository:${r.id}`;
        if (name === 'databaseId') return r.id;
        if (name === 'name') return r.name;
        if (name === 'nameWithOwner') return `${r.owner}/${r.name}`;
        if (name === 'owner') return wrap('User', { login: r.owner });
        if (name === 'defaultBranchRef') return { name: r.default_branch };
        if (name === 'viewerPermission') return 'ADMIN';
        if (name === 'hasIssuesEnabled') return true;
        if (name === 'issue') return wrap('Issue', r.issues.get(a.number), r);
        if (name === 'pullRequest') return wrap('PullRequest', r.pulls.get(a.number), r);
        if (name === 'issues') {
          let values = [...r.issues.values()].filter(i => !a.states || a.states.includes(i.state.toUpperCase()));
          values.sort((x, y) => a.orderBy?.direction === 'DESC' ? y.number - x.number : x.number - y.number);
          return connection('Issue', values, a, r);
        }
        if (name === 'pullRequests') return connection('PullRequest', [...r.pulls.values()].filter(p => p.state === 'open'), a, r);
      } else if (type === 'Issue' || type === 'PullRequest') {
        if (name === 'id') return `${type}:${value.id}`;
        if (name === 'state') return value.merged ? 'MERGED' : value.state.toUpperCase();
        if (name === 'headRefName') return value.head;
        if (name === 'baseRefName') return value.base;
        if (name === 'mergeable') return 'MERGEABLE';
        if (name === 'files' && type === 'PullRequest') return connection('ChangedFile', s.changes(repo!, value).map(f => ({ path: f.filename })), a);
        if ((schema[type] ?? []).includes(name)) return value[name];
      } else if (Object.hasOwn(value, name)) return value[name];
      throw new Error(`Cannot query field "${name}" on type "${type}".`);
    }
    function project(object: any, selection: Field[]): any {
      if (object == null) return null;
      if (Array.isArray(object)) return object.map(o => project(o, selection));
      if (!selection.length) return object;
      const { type = 'Object', value = object, repo } = object;
      return Object.fromEntries(selection.map(field => [field.alias, project(resolve(type, value, repo, field), field.fields)]));
    }
    return { data: project(wrap('Query', {}), fields) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw error;
    return { errors: [{ message: (error as Error).message }] };
  }
}
