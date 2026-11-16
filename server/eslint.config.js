import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

import {
  DB_ALLOWED,
  DB_BOOTSTRAP,
  DB_CONNECTION,
  DB_MODULES,
  DB_PACKAGES,
  TEST_FILES,
} from './class-boundary.mjs';

const DB_MESSAGE =
  'Only classes reach the database (docs/design/CLASSES.md): use or add a method on a class in src/classes/.';
const TEST_HELPER_MESSAGE =
  'Production code never loads test helpers (src/testing/, __tests__/); only tests do.';

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A module of class-boundary.mjs as a regex over the import specifiers that name it:
 * `src/models/mongoose/**` matches `../models/mongoose/Item.js`; `src/models/index.ts` matches
 * `../../models/index.js`. ESLint sees specifiers as written; the boundary test resolves them.
 */
function specifierPattern(module) {
  const path = module.replace(/^src\//, '');
  if (path.endsWith('/**')) return `(^|/)${escapeRegex(path.slice(0, -3))}(/|$)`;
  return `(^|/)${escapeRegex(path.replace(/\.ts$/, ''))}(\\.[jt]s)?$`;
}

const testHelperPattern = {
  regex: '(^|/)(testing|__tests__)/',
  message: TEST_HELPER_MESSAGE,
  allowTypeImports: true,
};

/** no-restricted-imports options: the database packages and these modules, and test helpers. */
function boundaryRule(modules) {
  return [
    'error',
    {
      // A database package is never imported here, not even for its types; a model's types are.
      paths: DB_PACKAGES.map((name) => ({ name, message: DB_MESSAGE })),
      patterns: [
        testHelperPattern,
        {
          regex: `^(${DB_PACKAGES.map(escapeRegex).join('|')})/`,
          message: DB_MESSAGE,
        },
        ...modules.map((module) => ({
          regex: specifierPattern(module),
          message: DB_MESSAGE,
          allowTypeImports: true,
        })),
      ],
    },
  ];
}

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
  // The class boundary (class-boundary.mjs). src/classes/classBoundary.test.ts holds the same
  // line, and also resolves paths, sees dynamic imports and getters named outside an import.
  // A later block's options replace an earlier one's for the files both match.
  {
    // Production code never loads test helpers.
    files: ['src/**/*.ts'],
    ignores: TEST_FILES,
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [testHelperPattern] }],
    },
  },
  {
    // Outside the allowed places, nothing loads the database.
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'infra/**/*.ts'],
    ignores: DB_ALLOWED,
    rules: { '@typescript-eslint/no-restricted-imports': boundaryRule(DB_MODULES) },
  },
  {
    // The entry points and jobs open the connection, and load nothing else of the database.
    files: DB_BOOTSTRAP,
    rules: {
      '@typescript-eslint/no-restricted-imports': boundaryRule(
        DB_MODULES.filter((module) => module !== DB_CONNECTION),
      ),
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
