// Fixture-owned pack step: produce a release view for demo-skill.
// This is where a content repo decides what ships and rewrites references.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const src = 'skills/demo-skill';
const out = `${src}/release/demo-skill`;

rmSync(`${src}/release`, { recursive: true, force: true });
mkdirSync(`${out}/plugins`, { recursive: true });
writeFileSync(
  `${out}/SKILL.md`,
  readFileSync(`${src}/SKILL.md`, 'utf8').replaceAll('demo.rhai', 'demo.goblin'),
);
cpSync(`${src}/plugins/demo.rhai`, `${out}/plugins/demo.goblin`);
