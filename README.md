# github-core-clone-01 — a GitHub-compatible git forge

A standalone forge in one Node 22 process, standard library only: no git binary, no
package manager, no outside service. The git pack protocol, the object store, and every
API surface are implemented here, in memory.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the environment
(`POST $MAKEFUN_ENV_URL/register {"port": N}`), polls `GET $MAKEFUN_ENV_URL/done`,
and exits 0 when the trial is over. It never binds 8080 — the environment owns it.

## Surfaces

- **Git smart HTTP** — `/{owner}/{repo}.git`: `info/refs` (v0 + v2 advertisement),
  `git-upload-pack` (protocol v2 `ls-refs`/`fetch` with shallow/deepen, and v0 fetch),
  `git-receive-pack` (v0, fast-forward checks, sideband report-status).
- **REST v3** — `/api/v3`: users, repositories, branches, commits, contents, labels,
  issues, comments, pull requests (incl. squash merge).
- **GraphQL** — `POST /api/graphql`: viewer, repository, node, `__type`, issues and
  pull-request connections with cursor pagination, and the create/close/merge mutations.
- **MCP** — `POST /mcp`: `server/discover` (modern era 2026-07-28) plus legacy
  `initialize`, and tools `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

## Determinism

Nothing in any reply reads the wall clock or an unseeded random source. Every
timestamp derives from `MAKEFUN_TRIAL_NOW` (the instance's opening time) plus a
monotonic sequence; every id comes from a counter; every global id is a stable
base64url encoding. Two runs on one instance answer byte-identically for the same
requests.

## License

MIT — see `LICENSE`.
