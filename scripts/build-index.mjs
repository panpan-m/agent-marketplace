#!/usr/bin/env node
/**
 * Writes plugin-index.json: the component index the marketplace reader can
 * use instead of the GitHub trees API, so refreshing this registry costs no
 * rate-limited API calls (the pattern xAI's registry uses). One entry per
 * marketplace plugin, keyed by its display name: skill folders count as
 * skills, remote MCP configs count as http connectors.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeJson } from "./lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

const index = { plugins: {} };
const raw = JSON.parse(await readFile(join(ROOT, "marketplace.json"), "utf8"));
for (const entry of raw.plugins ?? []) {
  const dir = join(ROOT, entry.source?.path?.slice(2) ?? "");
  const components = {};
  try {
    for (const item of await readdir(join(dir, "skills"), { withFileTypes: true })) {
      if (item.isDirectory()) (components.skills ??= []).push({});
    }
  } catch {
    // No skills folder.
  }
  for (const name of ["mcp.json", ".mcp.json"]) {
    let doc = null;
    try {
      doc = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const servers = Object.values(doc.mcpServers ?? {});
    if (servers.length) components.mcpServers = servers.map(() => ({ description: "http" }));
    break;
  }
  // The reader drops an entry the index cannot classify, so only index
  // plugins with at least one installable part.
  if (components.skills?.length || components.mcpServers?.length) {
    index.plugins[entry.name] = { components };
  } else {
    console.warn(`  index skipped: ${entry.name}`);
  }
}

await writeJson(join(ROOT, "plugin-index.json"), { version: 1, ...index });
console.log(`plugin-index.json: ${Object.keys(index.plugins).length} plugins`);
