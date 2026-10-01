// The live suite (src/__tests__/live): real systems, run only by
// `npm run test:live`. `npm test` ignores the directory (jest.config.js).
const base = require('./jest.config');

module.exports = {
  ...base,
  testMatch: ['**/__tests__/live/**/*.live.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
};
