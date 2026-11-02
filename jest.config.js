/** @type {import('jest').Config} */
const config = {
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { useESM: false }],
  },
  setupFiles: ['<rootDir>/jest.setup.js'],
};

module.exports = config;
