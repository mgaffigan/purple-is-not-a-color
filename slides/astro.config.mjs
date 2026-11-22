// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/. The deploy workflow passes the
  // right values (from actions/configure-pages); locally both default to the root.
  site: process.env.ASTRO_SITE || undefined,
  base: process.env.ASTRO_BASE || '/',
  // The dev toolbar would sit on top of the slides while presenting from `astro dev`.
  devToolbar: { enabled: false },
});
