import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { app } from './src/data/app.js';

/** Radix packages imported only by the signed-in app (lazy routes). */
const APP_ONLY_RADIX = ['react-popover', 'react-tooltip', 'react-switch', 'react-checkbox'];

/** The dashboard grid, the block editor and what only they use: they load lazily with the dashboard. */
const DASHBOARD_ONLY = [
  'react-grid-layout',
  'react-draggable',
  'react-resizable',
  'fast-equals',
  'resize-observer-polyfill',
  'prop-types',
  // The block editor (lazy) and the shared schemas it validates with.
  'react-querybuilder',
  'zod',
  // Data blocks (T4.6): the chart, the board's drag and drop, and the table.
  'recharts',
  'victory-vendor',
  'd3-array',
  'd3-color',
  'd3-ease',
  'd3-format',
  'd3-interpolate',
  'd3-path',
  'd3-scale',
  'd3-shape',
  'd3-time',
  'd3-time-format',
  'd3-timer',
  'internmap',
  'decimal.js-light',
  'es-toolkit',
  'eventemitter3',
  '@dnd-kit',
  '@tanstack/react-table',
  '@tanstack/table-core',
  '@fullcalendar',
  'rrule',
  'preact',
];

// https://vite.dev/config/
export default defineConfig(() => {
  const baseUrl = app.baseUrl.replace(/\/$/, '');

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'html-base-url',
        transformIndexHtml(html) {
          return html.replace(/__VITE_APP_URL__/g, baseUrl);
        },
      },
    ],
    assetsInclude: ['**/*.glb'],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@api-types': path.resolve(__dirname, '../server/src/types'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: (id): string | undefined => {
            // Vendor chunks for better caching. Keep React in "vendor" to avoid circular chunk.
            // Don't split react-router-dom into "router" — it can become an empty chunk when tree-shaken into app code.
            if (id.includes('node_modules')) {
              // Brand marks are used only by the landing page. Left to Rollup, the few icons it
              // imports (tree-shaken from thousands) go into that lazy route's chunk instead of
              // the vendor chunk every page loads.
              if (id.includes('/simple-icons/')) {
                return undefined;
              }
              // The command palette's engine is used only by the signed-in app shell (lazy).
              if (id.includes('/cmdk/')) {
                return undefined;
              }
              // Left to Rollup, the grid goes into the dashboard pages' lazy chunk.
              if (DASHBOARD_ONLY.some((name) => id.includes(`/node_modules/${name}/`))) {
                return undefined;
              }
              // Redux
              if (id.includes('@reduxjs/toolkit') || id.includes('react-redux')) {
                return 'redux';
              }
              // React Query
              if (id.includes('@tanstack/react-query')) {
                return 'query';
              }
              // Icons
              if (id.includes('lucide-react')) {
                return 'icons';
              }
              // Radix primitives only the signed-in app uses: their own chunk, loaded with the
              // app's lazy pages, so the public pages' eager ui-lib stays as it was.
              if (APP_ONLY_RADIX.some((name) => id.includes(`/@radix-ui/${name}/`))) {
                return 'ui-app';
              }
              // UI Library (Radix)
              if (id.includes('@radix-ui')) {
                return 'ui-lib';
              }
              // React, react-dom, and all other vendors in one chunk
              return 'vendor';
            }
            return undefined;
          },
        },
      },
      // Optimize chunk size
      chunkSizeWarningLimit: 1000,
    },
  };
});
