#!/usr/bin/env node
/**
 * Mirrors the official MCP registry (registry.modelcontextprotocol.io) and
 * vendors every server that could actually install through the agent-plugins
 * pipeline: a remote HTTPS endpoint, no placeholders, no embedded secrets.
 * Everything else (npm/stdio packages, metadata-only entries) is stdio-bound
 * or unpinned upstream, so it lands in the data mirror only.
 *
 * Owns: plugins/mcp-…, the mcp-… entries of marketplace.json, data/official-registry.json.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  MCP_SCHEMA,
  MANIFEST_SCHEMA,
  installableRemote,
  mergeMarketplace,
  prunePlugins,
  slugify,
  writeJson,
  writePlugin,
} from "./lib.mjs";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io";
const PAGE_LIMIT = 100;
const ROOT = new URL("..", import.meta.url).pathname;

async function getJson(url, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { accept: "application/json" },
      });
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw new Error(`HTTP ${response.status} (permanent)`);
      return await response.json();
    } catch (error) {
      if (String(error).includes("permanent") || attempt === tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function fetchAllServers(onPage) {
  const servers = [];
  let url = `${REGISTRY_BASE}/v0.1/servers?version=latest&limit=${PAGE_LIMIT}`;
  for (;;) {
    const page = await getJson(url);
    const batch = page.servers ?? [];
    servers.push(...batch);
    onPage?.(servers.length);
    const cursor = page.metadata?.nextCursor;
    if (!cursor) return servers;
    url = `${REGISTRY_BASE}/v0.1/servers?version=latest&limit=${PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`;
  }
}

function mirrorEntry(wrapper) {
  const server = wrapper.server ?? {};
  const meta = wrapper._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
  const packages = (server.packages ?? []).map((pkg) => ({
    registryType: pkg.registryType ?? null,
    identifier: pkg.identifier ?? null,
    version: pkg.version ?? null,
    runtimeHint: pkg.runtimeHint ?? null,
    transportType: pkg.transport?.type ?? null,
    transportUrl: typeof pkg.transport?.url === "string" ? pkg.transport.url : null,
  }));
  return {
    name: server.name ?? "",
    description: server.description ?? "",
    version: server.version ?? null,
    status: meta.status ?? null,
    publishedAt: meta.publishedAt ?? null,
    updatedAt: meta.updatedAt ?? null,
    repositoryUrl: server.repository?.url ?? null,
    remote: packages.filter((pkg) => pkg.transportUrl).map((pkg) => ({ type: pkg.transportType, url: pkg.transportUrl })),
    packages,
  };
}

await mkdir(join(ROOT, "data"), { recursive: true });
process.stdout.write("fetching official registry (latest versions)…\n");
const wrappers = await fetchAllServers((count) => process.stdout.write(`\r  ${count} servers`));
process.stdout.write("\n");

const mirror = wrappers.map(mirrorEntry).sort((a, b) => a.name.localeCompare(b.name));
await writeJson(join(ROOT, "data", "official-registry.json"), {
  source: `${REGISTRY_BASE}/v0.1/servers`,
  versionFilter: "latest",
  generatedAt: new Date().toISOString(),
  count: mirror.length,
  servers: mirror,
});

const kept = new Set();
const entries = [];
for (const wrapper of wrappers) {
  const server = wrapper.server ?? {};
  for (const pkg of server.packages ?? []) {
    const remote = installableRemote(pkg.transport);
    if (!remote) continue;
    const folder = slugify(server.name ?? pkg.identifier ?? "server", "mcp-");
    const serverKey = folder.replace(/^mcp-/, "").replace(/[^a-z0-9.-]/g, "-");
    await writePlugin(ROOT, folder, [
      [
        "plugin.json",
        `${JSON.stringify(
          {
            $schema: MANIFEST_SCHEMA,
            name: folder,
            description: (server.description ?? server.name ?? folder).slice(0, 4000),
            homepage: typeof server.repository?.url === "string" ? server.repository.url : undefined,
            repository: typeof server.repository?.url === "string" ? server.repository.url : undefined,
            license: "See upstream repository",
          },
          null,
          2,
        )}\n`,
      ],
      [
        "mcp.json",
        `${JSON.stringify(
          {
            $schema: MCP_SCHEMA,
            mcpServers: { [serverKey]: { type: remote.type, url: remote.url } },
          },
          null,
          2,
        )}\n`,
      ],
    ]);
    kept.add(folder);
    entries.push({
      name: (server.name ?? folder).slice(0, 120),
      description: (server.description ?? "").slice(0, 4000),
      category: "development",
      homepage: typeof server.repository?.url === "string" ? server.repository.url : undefined,
      source: { type: "local", path: `./plugins/${folder}` },
    });
    break; // One vendored config per server; the first installable transport wins.
  }
}

await mergeMarketplace(ROOT, entries, "mcp-");
await prunePlugins(ROOT, kept, "mcp-");
console.log(`registry mirror: ${mirror.length} servers; installable remote plugins: ${entries.length}`);
