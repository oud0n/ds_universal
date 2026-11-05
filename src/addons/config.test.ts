import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function hooks(addonsDir: string) {
  vi.stubEnv('LAPLOUPE_ADDONS_DIR', addonsDir);
  vi.resetModules();
  const { default: config } = await import('../../vite.config');
  type Hooks = { name: string; resolveId(id: string): string | null; transform(code: string, id: string): string | null };
  const plugin = config.plugins?.find((p): p is Hooks =>
    !!p && 'name' in p && p.name === 'laploupe-addons' && 'resolveId' in p && typeof p.resolveId === 'function'
    && 'transform' in p && typeof p.transform === 'function');
  if (!plugin) throw new Error('missing plugin');
  return plugin;
}
afterEach(() => { vi.unstubAllEnvs(); });

it('追加の入口と CSS の読み取り先には Vite の区切りを使い、ほかの CSS には足さない', async () => {
  const directory = resolve(root, 'extra components');
  const addon = await hooks(directory);
  expect(addon.resolveId('virtual:laploupe-addons')).toBe(normalizePath(resolve(directory, 'src/index.ts')));
  const css = normalizePath(resolve(root, 'src/index.css'));
  expect(addon.transform('css', css + '?direct')).toBe(`css\n@source ${JSON.stringify(normalizePath(resolve(directory, 'src')))};\n`);
  expect(addon.transform('css', 'src/other.css')).toBeNull();
});

it('通常のビルドは既定の入口を使い、CSS を変えない', async () => {
  const addon = await hooks('');
  expect(addon.resolveId('virtual:laploupe-addons')).toBe(normalizePath(resolve(root, 'src/addons/none.ts')));
  expect(addon.transform('css', normalizePath(resolve(root, 'src/index.css')))).toBeNull();
});
