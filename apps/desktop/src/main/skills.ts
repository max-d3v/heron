import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import type { Skill } from "@heron/core";
import type { HeronDb } from "@heron/db";
import type { Paths } from "./paths.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/i;

export const linkedSkillsRoot = () => join(homedir(), ".claude", "skills");

/** Parse `name` and `description` from SKILL.md frontmatter. */
export function readFrontmatter(md: string): { name: string | null; description: string | null } {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return { name: null, description: null };
  const get = (key: string) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]!);
    return line ? line[1]!.trim().replace(/^["']|["']$/g, "").replace(/\\"/g, '"') || null : null;
  };
  return { name: get("name"), description: get("description") };
}

async function listFiles(dir: string, root = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === ".git") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p, root)));
    else out.push(relative(root, p));
  }
  return out.sort();
}

/** Content hash of the whole skill folder, recorded in each run's snapshot. */
export async function hashSkill(dir: string): Promise<string> {
  const h = createHash("sha256");
  for (const f of await listFiles(dir)) {
    h.update(f);
    h.update("\0");
    h.update(await readFile(join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** The slash command a profile sends: /heron:<name> for imported skills, /<name> for linked ones. */
export function skillCommand(s: Pick<Skill, "name" | "source">): string {
  return s.source === "imported" ? `heron:${s.name}` : s.name;
}

export class SkillService {
  constructor(
    private readonly db: HeronDb,
    private readonly paths: Paths,
  ) {}

  async describe(s: Skill): Promise<{ description: string | null; exists: boolean }> {
    const file = join(s.path, "SKILL.md");
    if (!existsSync(file)) return { description: null, exists: false };
    return { description: readFrontmatter(await readFile(file, "utf8")).description, exists: true };
  }

  /** Copy a skill folder into Heron's plugin. */
  async importFolder(src: string): Promise<Skill> {
    const mdPath = join(src, "SKILL.md");
    if (!existsSync(mdPath)) throw new Error("That folder has no SKILL.md.");
    const fm = readFrontmatter(await readFile(mdPath, "utf8"));
    const name = fm.name && NAME_RE.test(fm.name) ? fm.name : basename(src);
    if (!NAME_RE.test(name)) throw new Error(`"${name}" isn't a valid skill name (letters, digits, - and _).`);
    if (this.db.listSkills().some((s) => s.source === "imported" && s.name === name)) {
      throw new Error(`A skill named "${name}" is already imported.`);
    }
    const dest = join(this.paths.pluginSkills, name);
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true, dereference: true, filter: (p) => !p.endsWith(".DS_Store") && !p.includes("/.git/") });
    return this.db.addSkill({ name, source: "imported", path: dest, contentHash: await hashSkill(dest) });
  }

  /** Import a skill that ships with Heron, or reuse an imported skill of the same name. */
  async installBundled(src: string): Promise<Skill> {
    const name = basename(src);
    return this.db.listSkills().find((s) => s.source === "imported" && s.name === name) ?? this.importFolder(src);
  }

  async listLinkable(): Promise<Array<{ name: string; description: string | null; linked: boolean }>> {
    const root = linkedSkillsRoot();
    if (!existsSync(root)) return [];
    const linked = new Set(this.db.listSkills().filter((s) => s.source === "linked").map((s) => s.name));
    const out = [];
    for (const entry of await readdir(root)) {
      const dir = join(root, entry);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      const md = join(dir, "SKILL.md");
      if (!existsSync(md)) continue;
      out.push({ name: entry, description: readFrontmatter(await readFile(md, "utf8")).description, linked: linked.has(entry) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reference a skill in ~/.claude/skills/<name> without copying it. */
  async link(name: string): Promise<Skill> {
    const dir = join(linkedSkillsRoot(), name);
    if (!existsSync(join(dir, "SKILL.md"))) throw new Error(`~/.claude/skills/${name}/SKILL.md not found.`);
    const existing = this.db.listSkills().find((s) => s.source === "linked" && s.name === name);
    if (existing) return existing;
    return this.db.addSkill({ name, source: "linked", path: dir, contentHash: await hashSkill(dir) });
  }

  async remove(id: number): Promise<void> {
    const skill = this.db.getSkill(id);
    if (!skill) return;
    const users = this.db.listProfiles().filter((p) => p.entry.type === "skill" && p.entry.skillId === id);
    if (users.length > 0) {
      throw new Error(`Used by ${users.map((p) => `"${p.name}"`).join(", ")}. Change those profiles first.`);
    }
    if (skill.source === "imported" && skill.path.startsWith(this.paths.pluginSkills)) {
      await rm(skill.path, { recursive: true, force: true });
    }
    this.db.deleteSkill(id);
  }

  async files(id: number): Promise<{ skillMd: string; files: string[]; editable: boolean }> {
    const skill = this.require(id);
    const md = join(skill.path, "SKILL.md");
    return {
      skillMd: existsSync(md) ? await readFile(md, "utf8") : "",
      files: existsSync(skill.path) ? await listFiles(skill.path) : [],
      editable: skill.source === "imported",
    };
  }

  async writeSkillMd(id: number, content: string): Promise<Skill> {
    const skill = this.require(id);
    if (skill.source !== "imported") throw new Error("Linked skills are edited where they live (~/.claude/skills).");
    await writeFile(join(skill.path, "SKILL.md"), content);
    return this.refreshHash(skill);
  }

  /** Recompute and store the content hash (before a run, after an edit). */
  async refreshHash(skill: Skill): Promise<Skill> {
    if (!existsSync(skill.path)) return skill;
    const contentHash = await hashSkill(skill.path);
    if (contentHash !== skill.contentHash) this.db.updateSkillHash(skill.id, contentHash);
    return { ...skill, contentHash };
  }

  require(id: number): Skill {
    const skill = this.db.getSkill(id);
    if (!skill) throw new Error(`Skill ${id} not found`);
    return skill;
  }
}
