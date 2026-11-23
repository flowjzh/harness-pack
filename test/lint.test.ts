import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { lintSkill } from '../src/lint.js';

function skill(name: string, frontmatter: string, body = '# body\n') {
  const root = mkdtempSync(path.join(tmpdir(), 'hp-lint-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`);
  return dir;
}

describe('lint', () => {
  it('accepts a spec-compliant skill', () => {
    expect(lintSkill(skill('good-skill', 'name: good-skill\ndescription: does a thing'))).toEqual([]);
  });

  it('rejects a name that does not match the directory', () => {
    const issues = lintSkill(skill('dir-name', 'name: other-name\ndescription: x'));
    expect(issues.some((i) => i.severity === 'error' && /must match/.test(i.message))).toBe(true);
  });

  it('rejects a missing description and a bad name casing', () => {
    const missing = lintSkill(skill('no-desc', 'name: no-desc'));
    expect(missing.some((i) => /description is required/.test(i.message))).toBe(true);
    const upper = lintSkill(skill('BadCase', 'name: BadCase\ndescription: x'));
    expect(upper.some((i) => /kebab-case/.test(i.message))).toBe(true);
  });

  it('warns on non-standard frontmatter fields', () => {
    const issues = lintSkill(skill('extra-fields', 'name: extra-fields\ndescription: x\npaths: src/**'));
    expect(issues.some((i) => i.severity === 'warning' && /paths/.test(i.message))).toBe(true);
  });
});
