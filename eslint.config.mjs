import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // A foreign feature is reached through its public index, never a file
      // under that feature. Local ./service and ./schemas imports remain valid.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '(^|/)(auth|hr|talent-acquisition|jobs|candidates|applications|offers|calling|employees|onboarding|leave|attendance)/.+',
              message:
                'Import another module through its public entrypoint and exported services, not its internal files. Shared contracts belong in shared/.',
            },
          ],
        },
      ],
    },
  },
);
