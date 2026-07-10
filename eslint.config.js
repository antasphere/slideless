import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/node_modules/**',
      '**/public/**',
      '**/drizzle/**',
      '**/playwright-report/**',
      '**/test-results/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Scope the svelte configs to svelte files only — some of their entries
  // (e.g. prefer-const tweaks) ship without a `files` filter and would
  // otherwise rewrite rules for the whole monorepo.
  ...svelte.configs.recommended.map((c) => ({
    ...c,
    files: c.files ?? ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js']
  })),
  prettier,
  ...svelte.configs.prettier.map((c) => ({
    ...c,
    files: c.files ?? ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js']
  })),
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        // TS inside <script lang="ts"> blocks and .svelte.ts modules.
        parser: tseslint.parser,
        extraFileExtensions: ['.svelte']
      }
    }
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // The SPA is served from the origin root (no base path), so bare hrefs
      // and goto('/x') are correct; resolve() would add noise for nothing.
      // (Applies to .ts too — the rule follows $app/navigation imports.)
      'svelte/no-navigation-without-resolve': 'off'
    }
  },
  {
    // Dependency direction: nothing imports the server.
    files: ['packages/sdk/**/*.ts', 'packages/contract/**/*.ts', 'packages/db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@slideless/server', '@slideless/server/*'], message: 'Nothing imports the server.' }
          ]
        }
      ]
    }
  },
  {
    // Client side of the split: sdk + dashboard (including .svelte files) see
    // the contract ROOT only — no db, no server, and not the hono-touching
    // routes entry.
    files: [
      'packages/sdk/**/*.ts',
      'apps/dashboard/src/**/*.ts',
      'apps/dashboard/src/**/*.svelte',
      'apps/dashboard/src/**/*.svelte.ts'
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@slideless/server', '@slideless/server/*'], message: 'Nothing imports the server.' },
            {
              group: ['@slideless/db', '@slideless/db/*'],
              message: 'Clients never touch the database layer.'
            },
            {
              group: ['@slideless/contract/routes', '@slideless/contract/routes/*'],
              message: 'The routes entry pulls Hono — clients import the contract root only.'
            }
          ]
        }
      ]
    }
  }
);
