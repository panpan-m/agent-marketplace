#!/usr/bin/env node
/**
 * Vendors skills from the whitelisted sources in ../sources.json into
 * plugins/skill-… (one skill per plugin, so each installs on its own).
 * Only the files an install can carry are copied: SKILL.md plus text
 * reference files. Scripts and binaries are never installed downstream,
 * so they are not vendored. Every skill keeps its own LICENSE.txt.
 *
 * Owns: plugins/skill-…, the skill-… entries of marketplace.json.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  LIMITS,
  MANIFEST_SCHEMA,
  frontmatterOf,
  mergeMarketplace,
  prunePlugins,
  safeFolderName,
  slugify,
} from "./lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const sources = JSON.parse(await readFile(join(ROOT, "sources.json"), "utf8")).sources;

function globToRegExp(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}/SKILL\\.md$`);
}

const kept = new Set();
const entries = [];

for (const source of sources) {
  const work = join(tmpdir(), `skill-source-${source.id}-${Date.now()}`);
  console.log(`cloning ${source.repo}`);
  execFileSync("git", ["clone", "--depth", "1", "--quiet", source.repo, work], { stdio: "inherit" });

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();
  const patterns = source.includeGlobs.map(globToRegExp);

  async function walk(dir, base = "") {
    const out = [];
    for (const name of await readdir(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${name.name}` : name.name;
      if (name.isDirectory()) out.push(...(await walk(join(dir, name.name), rel)));
      else out.push(rel);
    }
    return out;
  }
  const files = await walk(work);

  const skillMds = files.filter((rel) => patterns.some((pattern) => pattern.test(rel)));
  for (const rel of skillMds) {
    const skillDir = join(work, rel.slice(0, -"/SKILL.md".length));
    const skillName = rel.split("/").at(-2);
    const skillMd = await readFile(join(skillDir, "SKILL.md"), "utf8");
    const frontmatter = frontmatterOf(skillMd);
    if (!frontmatter.name || !frontmatter.description) {
      console.warn(`  skip ${rel}: frontmatter needs name and description`);
      continue;
    }
    if (frontmatter.name.length > 80 || frontmatter.description.length > 2000) {
      console.warn(`  skip ${rel}: name/description exceeds skill limits`);
      continue;
    }
    if (Buffer.byteLength(skillMd) > LIMITS.maxFileBytes) {
      console.warn(`  skip ${rel}: SKILL.md exceeds the ${LIMITS.maxFileBytes}-byte install limit`);
      continue;
    }

    // Companions: text reference files only, inside the skill's size budget.
    const companions = [];
    let bytes = 0;
    for (const candidate of files.filter((f) => f.startsWith(`${rel.slice(0, -"SKILL.md".length)}`) && f !== rel)) {
      if (!LIMITS.skillTextFile.test(candidate)) continue; // scripts and binaries are never installed
      const info = await stat(join(work, candidate));
      if (info.size > LIMITS.maxFileBytes || bytes + info.size > LIMITS.maxSkillFilesBytes) {
        console.warn(`  skip file ${candidate}: over size budget`);
        continue;
      }
      if (companions.length >= LIMITS.maxSkillFiles - 1) break;
      companions.push(candidate);
      bytes += info.size;
    }

    const folder = slugify(frontmatter.name || skillName, "skill-");
    const skillFolder = safeFolderName(frontmatter.name);
    const dest = join(ROOT, "plugins", folder);
    await rm(dest, { recursive: true, force: true });
    await mkdir(join(dest, "skills", skillFolder), { recursive: true });
    await cp(join(skillDir, "SKILL.md"), join(dest, "skills", skillFolder, "SKILL.md"));
    for (const companion of companions) {
      const suffix = companion.slice(rel.slice(0, -"SKILL.md".length).length);
      const target = join(dest, "skills", skillFolder, suffix);
      await mkdir(join(target, ".."), { recursive: true });
      await cp(join(work, companion), target);
    }
    await writeFile(
      join(dest, "plugin.json"),
      `${JSON.stringify(
        {
          $schema: MANIFEST_SCHEMA,
          name: folder,
          description: frontmatter.description.slice(0, 4000),
          repository: source.repo,
          homepage: source.repo,
          license: frontmatter.license ?? "See LICENSE.txt beside SKILL.md",
          keywords: ["skill", source.id],
        },
        null,
        2,
      )}\n`,
    );
    kept.add(folder);
    entries.push({
      name: frontmatter.name.slice(0, 120),
      description: frontmatter.description.slice(0, 4000),
      category: "Skills",
      keywords: ["skill", source.id],
      homepage: source.repo,
      source: { type: "local", path: `./plugins/${folder}` },
    });
    console.log(`  vendored ${frontmatter.name} (${companions.length} companion files) [${commit.slice(0, 8)}]`);
  }

  await rm(work, { recursive: true, force: true });
}

await mergeMarketplace(ROOT, entries, "skill-");
await prunePlugins(ROOT, kept, "skill-");
console.log(`skills vendored: ${entries.length} from ${sources.length} sources`);
