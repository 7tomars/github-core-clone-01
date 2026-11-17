# Forge — a GitHub-compatible git forge in one Node process

A standalone forge that speaks the four surfaces a GitHub client expects, from a
single in-memory store:

- **git smart HTTP** — protocol v2 `ls-refs` and `fetch` (with shallow/deepen),
  v0 fetch, and v0 `receive-pack` pushes with `report-status`, per-ref
  fast-forward enforcement and sideband framing. Real git object semantics:
  SHA-1 addressed blobs, trees, commits and annotated tags; packfiles are
  parsed (including ofs/ref deltas) and written by the forge itself.
- **REST v3** under `/api/v3` — repositories, branches, commits, the contents
  API (which commits into the same git store), labels, issues, comments and
  pull requests with squash merges and real three-way conflict detection.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server`
  send: viewer/repository reads, issue and pull-request connections with cursor
  pagination, introspection probes, and the create/close/merge/comment
  mutations, with opaque, stable Relay global ids.
- **MCP** at `/mcp` — JSON-RPC over streamable HTTP, both the modern
  `server/discover` revision and the legacy `initialize` handshake, with six
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store.

Because every surface shares one store, an object created through any of them
reads back identically through the others — same ids, same numbers, same bytes.

## Running

The program is the make.fun entry lifecycle: it binds an ephemeral port,
registers it with `$MAKEFUN_ENV_URL`, serves until the env reports done, and
exits 0.

```
node --experimental-strip-types main.ts
```

Node 22, standard library only — no dependencies, no install step, no git
binary, no network beyond the env. State is in memory; timestamps come from a
logical clock seeded by `MAKEFUN_TRIAL_NOW`, so replays are byte-identical.

## Layout

- `main.ts` — the lifecycle (register, poll done, exit).
- `app.ts` — HTTP routing, auth, and the cross-cutting wire rules.
- `core.ts` — the store and the git object engine (hashing, trees, packs, pkt-lines).
- `git.ts` — smart HTTP: advertisements, ls-refs, fetch planning, receive-pack.
- `rest.ts` — the REST v3 resources, contents commits, PR diffs and merges.
- `gql.ts` — the GraphQL parser/executor and global-id codec.
- `mcp.ts` — the MCP endpoint and its tools.
