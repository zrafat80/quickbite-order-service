/** @type {import('jest').Config} */
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/unit/setup.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
      },
    ],
  },
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    '<rootDir>/src/app/order/order-status.service.ts',
    '<rootDir>/src/app/agent/agent.service.ts',
    '<rootDir>/src/app/agent/presence.service.ts',
    '<rootDir>/src/app/restaurant-finance/restaurant-finance.service.ts',
    '<rootDir>/src/app/payment/payment.service.ts',
    '<rootDir>/src/app/agent/repository/agent-earning.repository.ts',
    '<rootDir>/src/app/agent/repository/agent-presence.repository.ts',
    '<rootDir>/src/app/order/repository/order-item.repository.ts',
    '<rootDir>/src/app/payment/repository/payment-provider.repository.ts',
    '<rootDir>/src/app/restaurant-finance/repository/restaurant-balance.repository.ts',
    '<rootDir>/src/lib/pagination/*.ts',
    '<rootDir>/src/pkg/utils/*.ts',
    '<rootDir>/src/pkg/payments/kashier/kashier.signature.ts',
  ],
  coverageDirectory: '<rootDir>/coverage/unit',
  coverageThreshold: {
    global: {
      statements: 80,
      lines: 80,
      functions: 75,
      branches: 65,
    },
  },
};
