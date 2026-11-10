import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Format rules mirrored from the agent-plugins parser the consumer runs
 * (packages/adapters/src/plugin-connectors.ts in the Rakazo tree). Keep the
 * generated tree inside these limits or installs will refuse parts. */
export const LIMITS = {
  maxFileBytes: 100_000,
  maxSkillFiles: 40,
  maxSkillFilesBytes: 400_000,
  pluginNamePattern: /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
  pluginNameMax: 64,
  /** Reference files a skill may carry; scripts and binaries are never installed. */
  skillTextFile: /\.(md|mdx|txt|json|ya?ml|csv)$/i,
};

export function slugify(value, prefix) {
  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = "item";
  slug = `${prefix}${slug}`;
  if (slug.length > LIMITS.pluginNameMax) slug = slug.slice(0, LIMITS.pluginNameMax);
  // Re-trim so the name still ends with an allowed character after truncation.
  slug = slug.replace(/[^a-z0-9]$/, "");
  if (!LIMITS.pluginNamePattern.test(slug)) throw new Error(`slug failed plugin name rules: ${slug}`);
  return slug;
}

export function frontmatterOf(skillMd) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd.replace(/^\uFEFF/, ""));
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Writes a generated plugin folder, replacing any previous generation. */
export async function writePlugin(root, folder, files) {
  const dir = join(root, "plugins", folder);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [path, content] of files) {
    await mkdir(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A skill folder name the install path accepts (no traversal, placeholders,
 * or control characters — mirrors the consumer's safePath rules). */
export function safeFolderName(name) {
  const folder = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!folder || folder === "." || folder === ".." || /[#?%]/.test(folder)) {
    throw new Error(`skill name cannot become a safe folder: ${name}`);
  }
  return folder;
}

/** Replaces this generator's namespace of marketplace entries, keeping the rest. */
export async function mergeMarketplace(root, newEntries, folderPrefix) {
  const { readFile } = await import("node:fs/promises");
  const path = join(root, "marketplace.json");
  let index = { plugins: [] };
  try {
    index = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // First run.
  }
  const others = (index.plugins ?? []).filter(
    (entry) => !(entry.source?.type === "local" && entry.source.path.includes(`/plugins/${folderPrefix}`)),
  );
  const merged = [...others, ...newEntries].sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(path, { plugins: merged });
}

/** Drops generated plugin folders this run did not rewrite. */
export async function prunePlugins(root, kept, prefix) {
  const dir = join(root, "plugins");
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix) && !kept.has(name)) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
}

export const MANIFEST_SCHEMA = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
export const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json";

/** Only remote HTTPS endpoints without placeholders can ever install;
 * the consumer's parser rejects everything else, so do not vendor it. */
export function installableRemote(transport) {
  if (!transport || typeof transport !== "object") return null;
  const type = transport.type;
  if (type !== "streamable-http" && type !== "sse" && type !== "http") return null;
  const url = transport.url;
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  if (/\$\{|\{[A-Za-z0-9_-]+\}/.test(url)) return null;
  if (/(auth|credential|key|password|secret|token)=/i.test(url)) return null;
  // Endpoints that only work inside another catalog's own app are refused downstream.
  if (/(^|\.)(cursor\.com|cursor\.sh|grok\.com|x\.ai)$/i.test(new URL(url).hostname)) return null;
  return { type: type === "http" ? "streamable-http" : type, url };
}
