import { defineConfig } from 'astro/config';
import facts from './practice-records/practices/graphdozer-sandbox/website-facts.json' with { type: 'json' };

export default defineConfig({
  site: facts.domain,
  output: 'static',
  outDir: './dist',
  trailingSlash: 'always',
});
