import path from "path";

import tailwindCaido from "@caido/tailwindcss";
import { defineConfig } from "@caido-community/dev";
import vue from "@vitejs/plugin-vue";
import prefixwrap from "postcss-prefixwrap";
import tailwindcss from "tailwindcss";
// @ts-expect-error tailwindcss-primeui does not publish TypeScript declarations.
import tailwindPrimeui from "tailwindcss-primeui";

import { PLUGIN_VERSION } from "./packages/shared/src/catalog";

const id = "mimikyu";

export default defineConfig({
  id,
  name: "Mimikyu",
  description:
    "Execute selected Caido traffic through a persistent browser session.",
  version: PLUGIN_VERSION,
  author: {
    name: "Incogbyte",
    url: "https://github.com/incogbyte",
  },
  plugins: [
    {
      kind: "backend",
      id: "mimikyu-backend",
      root: "packages/backend",
      assets: [
        "./agent",
        "./docker/chrome",
        "./docker-compose.mimikyu.yml",
        "./LICENSE",
      ],
    },
    {
      kind: "frontend",
      id: "mimikyu-frontend",
      root: "packages/frontend",
      backend: {
        id: "mimikyu-backend",
      },
      vite: {
        plugins: [vue()],
        build: {
          rollupOptions: {
            external: ["@caido/frontend-sdk", "vue"],
          },
        },
        resolve: {
          alias: [
            {
              find: "@",
              replacement: path.resolve(__dirname, "packages/frontend/src"),
            },
          ],
        },
        css: {
          postcss: {
            plugins: [
              prefixwrap(`#plugin--${id}`),
              tailwindcss({
                corePlugins: {
                  preflight: false,
                },
                content: [
                  "./packages/frontend/src/**/*.{vue,ts}",
                  "./node_modules/@caido/primevue/dist/primevue.mjs",
                ],
                darkMode: ["selector", '[data-mode="dark"]'],
                plugins: [tailwindPrimeui, tailwindCaido],
              }),
            ],
          },
        },
      },
    },
  ],
});
