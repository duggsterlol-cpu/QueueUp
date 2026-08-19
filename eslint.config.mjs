// Catches the class of bug that shipped in 1.2.0/1.2.1: a function referenced
// but never defined. `node --check` only validates syntax, so it sails past.
// `npm run check` runs this and must pass before any release.

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', console: 'readonly', fetch: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', WebSocket: 'readonly',
  AbortController: 'readonly', Promise: 'readonly', Symbol: 'readonly',
  URLSearchParams: 'readonly', getComputedStyle: 'readonly',
  innerWidth: 'readonly', innerHeight: 'readonly'
};

const nodeGlobals = {
  require: 'readonly', module: 'writable', process: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly',
  console: 'readonly', fetch: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', AbortController: 'readonly',
  Promise: 'readonly', Symbol: 'readonly', URL: 'readonly'
};

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-redeclare': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error'
};

export default [
  {
    files: ['electron/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    rules
  },
  {
    files: ['app/**/*.js', 'overlay/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: browserGlobals
    },
    rules
  }
];
