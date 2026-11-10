# agent-marketplace

A self-maintained plugin marketplace index: vendored agent skills plus every
server in the [official MCP registry](https://registry.modelcontextprotocol.io)
that can actually install as a remote connector.

## Layout

```
marketplace.json             index of installable entries (agent-plugins marketplace format)
plugins/skill-*/             one vendored skill per plugin: skills/<name>/SKILL.md + text references
plugins/mcp-*/               vendored remote MCP connectors (plugin.json + mcp.json)
data/official-registry.json  full mirror of the official registry (latest version of every server)
sources.json                 skills whitelist: repository, license, include globs
scripts/                     generators — everything above is their output
```

## Why so few MCP entries

The official registry holds tens of thousands of servers, but almost all of
them ship as npm/stdio packages or metadata-only entries. The agent-plugins
install pipeline deliberately refuses stdio transports from plugins and only
accepts remote `https://` endpoints without placeholders or embedded secrets,
so only the small remote-hosted subset (147 at the last sync) can be vendored
as installable entries. The rest stays in `data/official-registry.json` as a
discovery mirror for tooling.

## Maintenance

```sh
node scripts/sync-registry.mjs   # re-mirror the official registry, regen plugins/mcp-*
node scripts/sync-skills.mjs     # re-vendor whitelisted skill sources into plugins/skill-*
```

Both scripts are idempotent: they rewrite their own namespace (`plugins/mcp-*`,
`plugins/skill-*`, and their `marketplace.json` entries) and leave everything
else alone. Commit and push the diff; consumers read `HEAD` over HTTPS.

To add a skill source: verify its license, add an entry to `sources.json`,
and run `scripts/sync-skills.mjs`. To add your own skill or connector by hand,
create `plugins/<folder>/` in the same layout and add a matching
`marketplace.json` entry — just keep out of the two generated prefixes.

## Licenses

Vendored skills carry their upstream `LICENSE.txt` beside `SKILL.md`
(attribution per source in `sources.json`). MCP connectors point at their
upstream repositories; this index adds only generated manifests.
