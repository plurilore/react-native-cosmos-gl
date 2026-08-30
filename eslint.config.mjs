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

      // The React Compiler rules, which arrived with eslint-plugin-react-hooks
      // v7, are warnings here rather than errors — `npm run lint` pins the
      // count, so it can fall and never rise. Each is a real pattern in this
      // codebase rather than an oversight:
      //
      // - `refs`: the component owns a GL context, a frame loop and the engine
      //   itself in refs, and assigns config into one during render so the
      //   frame loop reads fresh props without a re-render. That is the design.
      // - `immutability`: Reanimated shared values are mutated through
      //   `.value` by definition; the rule does not model them.
      // - `set-state-in-effect`: the overlay components place themselves from a
      //   timer, which is a subscription, not a render-time computation.
      // - `preserve-manual-memoization` / `static-components`: memoisation
      //   deliberately keyed on content rather than identity.
      //
      // Fixing them is a refactor of working code, not a lint pass. Lower the
      // ceiling when one goes; never raise it.
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/static-components': 'warn',

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
