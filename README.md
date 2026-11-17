[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tacinbau/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tacinbau/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
# make.fun github-core-clone-01

A standalone, in-memory GitHub-compatible git forge implemented in TypeScript using only the Node.js standard library. Repository data lasts for the lifetime of the process.

Implemented surfaces:

- REST at `/api/v3`: repositories, issues and comments, labels, pull requests and merges, contents, branches, refs, and commit listing.
- GraphQL at `/api/graphql`: repository, issue, and pull request queries, cursor pagination, and issue, pull request, comment, and merge mutations.
- MCP at `/mcp`: discovery and initialization, plus `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, and `merge_pull_request` tools.
- Git smart HTTP at `/<owner>/<repo>.git`: v0 clone/fetch/push and v2 fetch, shallow/deepen support, annotated tags, and v2 `ls-refs` with peeled tags and symbolic refs. Pack handling supports SHA-1 objects and delta decoding.

Use Node.js 22.18 or later with built-in TypeScript stripping; no install step or external dependencies are needed:

```sh
MAKEFUN_ENV_URL=http://environment-host:port \
MAKEFUN_SHOP_TOKEN=your-token \
node main.ts
```

`MAKEFUN_ENV_URL` is required. The forge listens on an automatically assigned port (`0`), posts that port to the environment's `/register`, polls `/done`, then closes and exits 0. SIGTERM and SIGINT also close the server and exit 0. Authenticated API and git requests require `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; `/healthz` is public.

Reported local `grade-local` result: **988/1000** — feature **600/600**, agent **200/200**, performance **188/200**. All **120 conformance checks** passed.
