# github-core-clone-01

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![Referral](https://img.shields.io/badge/referral-px0jp2xy-green)](https://make.fun/r/px0jp2xy)

A GitHub-compatible git forge in one Node process, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01): git smart HTTP
(upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4, and a
Model Context Protocol endpoint — all served from one in-memory store, with no
git binary, no outside service and no UI.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the trial environment at
`$MAKEFUN_ENV_URL`, serves until the environment answers `{"done": true}` on
`/done`, then exits 0. It needs `MAKEFUN_SHOP_TOKEN` in its environment: the
bearer token the suite presents on every API call.

## Layout

- `main.ts` — the lifecycle: bind, register, poll `/done`, exit 0.
- `app.ts` — the HTTP front door: routing, body reading, request ids.
- `store.ts` — the forge's whole state: repositories, git objects and refs,
  issues, pull requests, labels and comments, plus the fetch/push engine.
- `gitcore.ts` — git's wire primitives: pkt-lines, SHA-1 objects, packfiles.
- `githttp.ts` — git smart HTTP: advertisements, ls-refs, fetch, receive-pack.
- `rest.ts` — GitHub REST v3 under `/api/v3`.
- `graphql.ts` — GitHub GraphQL v4 at `/api/graphql`.
- `mcp.ts` — Model Context Protocol at `/mcp` (revision 2026-07-28).
- `scenario.ts` — the trial's seeded scenario, re-derived so the forge knows
  which login its bearer token owns.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges |
| `POST /api/graphql` | GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | MCP over streamable HTTP: `server/discover`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

## Notes

- Everything is in-memory and deterministic: no wall clock reaches a response,
  commit timestamps come from a fixed epoch plus a per-repository counter, and
  the same request sequence builds byte-identical objects.
- A push that is not a fast-forward is refused per ref with
  `ng <ref> non-fast-forward` and the ref does not move; a mixed push applies
  the fast-forward ref and reports each ref on its own line.
- A repository belongs to the login the bearer token names; the same name under
  another owner is 404, never 403.
