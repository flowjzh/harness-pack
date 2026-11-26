import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { runBuild } from '../src/pipeline.js';
import type { BuildOptions } from '../src/types.js';

export const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'minimal');

export function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hp-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Build steps write into the source tree by contract, so every test runs on
// its own copy instead of mutating the fixture. The optional mutate hook
// patches the copy before the build runs.
export function build(extra: Partial<BuildOptions> = {}, mutate?: (root: string) => void) {
  const root = tempDir();
  cpSync(fixtureRoot, root, { recursive: true });
  mutate?.(root);
  return runBuild({ configPath: path.join(root, 'pack.yaml'), outDir: path.join(root, 'dist'), ...extra });
}
