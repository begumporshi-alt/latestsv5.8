/** @type {import('jest').Config} */
const config = {
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { useESM: false }],
  },
};

module.exports = config;
