import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', 'reports/**', 'test-results/**', 'packages/contracts/src/generated/**', 'apps/web/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-console': 'off',
      // The LLM boundary depends on there being no dynamic code paths.
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
);
