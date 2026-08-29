import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['lib/**', 'example/**', 'reference/**', 'src/core/shaders/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The hooks rules matter here: the component holds a GL context and a
    // render loop in refs, and a dependency array that silently re-runs an
    // effect would tear down and rebuild the graph.
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The GL layer talks to an untyped context and casts typed-array views
      // into BufferSource positions the DOM lib types too narrowly.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `expo-gl` is resolved at call time on purpose — see react/gl-view.ts.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
