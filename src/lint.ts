import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { LintIssue } from './types.js';

// Checks the portable subset of the Agent Skills spec (agentskills.io):
// anything that passes here loads in every harness that claims the standard.
// Harness-specific frontmatter extensions are intentionally not validated.
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function lintSkill(skillDir: string): LintIssue[] {
  const label = path.basename(skillDir);
  const issues: LintIssue[] = [];
  const add = (severity: LintIssue['severity'], message: string) => issues.push({ skill: label, severity, message });

  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) {
    add('error', 'SKILL.md is missing');
    return issues;
  }
  const text = readFileSync(skillFile, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) {
    add('error', 'SKILL.md has no YAML frontmatter');
    return issues;
  }
  let front: Record<string, unknown>;
  try {
    front = (parse(match[1]) ?? {}) as Record<string, unknown>;
  } catch (e) {
    add('error', `frontmatter is not valid YAML: ${e instanceof Error ? e.message : e}`);
    return issues;
  }

  const name = front.name;
  if (typeof name !== 'string' || !name) {
    add('error', 'frontmatter.name is required');
  } else {
    if (name !== label) add('error', `frontmatter.name '${name}' must match the directory name '${label}'`);
    if (name.length > 64) add('error', 'frontmatter.name exceeds 64 characters');
    if (!NAME_RE.test(name)) add('error', `frontmatter.name '${name}' must be lowercase kebab-case`);
  }

  const description = front.description;
  if (typeof description !== 'string' || !description) {
    add('error', 'frontmatter.description is required');
  } else if (description.length > 1024) {
    add('error', 'frontmatter.description exceeds 1024 characters');
  }

  for (const key of Object.keys(front)) {
    if (!['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(key)) {
      add('warning', `non-standard frontmatter field '${key}' (ignored by strict harnesses)`);
    }
  }

  const body = text.slice(match[0].length);
  if (body.split('\n').length > 500) {
    add('warning', 'SKILL.md body exceeds 500 lines; move detail into references/');
  }
  return issues;
}

export function lintSkills(skillDirs: string[]): LintIssue[] {
  return skillDirs.flatMap((dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return [{ skill: path.basename(dir), severity: 'error' as const, message: `skill directory not found: ${dir}` }];
    }
    return lintSkill(dir);
  });
}
