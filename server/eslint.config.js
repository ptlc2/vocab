import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
    js.configs.recommended,
    prettier,
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules: {
            eqeqeq: ['error', 'always'],
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }],
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
            'no-shadow': ['warn', { builtinGlobals: false }],
            'no-param-reassign': ['warn', { props: false }],
            'prefer-template': 'warn',
            'prefer-arrow-callback': ['warn', { allowNamedFunctions: false }],
            'no-return-await': 'warn',
        },
    },
    {
        files: ['static/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.browser,
        },
    },
    {
        files: ['tests/*.dom.test.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.node },
        },
    },
];
