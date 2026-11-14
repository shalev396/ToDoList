import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

import { DB_ALLOWED, LEGACY_DB_IMPORTERS } from './legacy-db-importers.mjs';

const DB_MESSAGE =
  'Only classes reach the database (docs/design/CLASSES.md): use or add a method on a class in src/classes/.';

export default tseslint.config(
  {
    files: ['**/*.{ts,js}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: {
        // src/ is checked by tsconfig.json; infra/ and scripts/ by infra/tsconfig.json.
        project: ['./tsconfig.json', './infra/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-debugger': 'error',
    },
  },
  {
    // The class boundary: outside the allowed places (and the shrinking legacy list), nothing
    // loads the models or mongoose at run time. src/classes/classBoundary.test.ts holds the same
    // line, and also sees dynamic imports and getters named outside an import.
    files: ['src/**/*.ts'],
    ignores: [...DB_ALLOWED, ...LEGACY_DB_IMPORTERS],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'mongoose', message: DB_MESSAGE, allowTypeImports: true }],
          patterns: [
            {
              regex: '(^|/)models/(index(\.js)?|mongoose(/.*)?)$',
              message: DB_MESSAGE,
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // CDK constructs are instantiated for their side effects (new CfnOutput(...)).
    files: ['infra/**/*.ts'],
    rules: {
      'no-new': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    // Offline-server stand-in for S3 browser uploads: undici's Request.formData() is flagged as
    // deprecated for large server-side bodies; here it only parses small local uploads (≤ 5 MB),
    // and a multipart dependency in the Lambda bundle for a local-only route isn't worth it.
    files: ['src/routes/public/localStorage.ts'],
    rules: { '@typescript-eslint/no-deprecated': 'off' },
  },
  {
    // node:test describe/it return promises the runner tracks itself.
    files: ['infra/test/**/*.ts', 'src/**/*.test.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    ignores: [
      'node_modules/**',
      'cdk.out/**',
      '.build/**',
      'infra/functions/**',
      'infra/composer/**',
      'infra/fixtures/**',
      'eslint.config.js',
    ],
  },
);
