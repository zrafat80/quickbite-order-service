import type { ShardedKnex } from 'src/lib/sharding/shards';

export function createTransactionMock() {
  const query: Record<string, jest.Mock> = {};
  let resolvedValue: unknown;
  for (const method of [
    'andWhere',
    'andWhereRaw',
    'delete',
    'first',
    'forUpdate',
    'insert',
    'join',
    'limit',
    'orWhere',
    'orderBy',
    'returning',
    'select',
    'transacting',
    'update',
    'where',
    'whereIn',
    'whereLike',
  ]) {
    query[method] = jest.fn(() => query);
  }
  query.then = jest.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve(resolve(resolvedValue)),
  );

  const transaction = jest.fn(() => query) as jest.Mock & {
    commit: jest.Mock;
    rollback: jest.Mock;
    fn: { now: jest.Mock };
    raw: jest.Mock;
  };
  transaction.commit = jest.fn().mockResolvedValue(undefined);
  transaction.rollback = jest.fn().mockResolvedValue(undefined);
  transaction.fn = { now: jest.fn(() => 'database-now') };
  transaction.raw = jest.fn();

  return {
    transaction,
    query,
    setResult(value: unknown) {
      resolvedValue = value;
    },
  };
}

export function createShardedKnexMock() {
  const transactionDoubles = createTransactionMock();
  const { transaction, query } = transactionDoubles;
  const database = jest.fn(() => query) as jest.Mock & {
    raw: jest.Mock;
    transaction: jest.Mock;
  };
  database.raw = jest.fn();
  database.transaction = jest.fn().mockResolvedValue(transaction);

  const knex = {
    db: jest.fn(() => database),
    dbArchive: jest.fn(() => database),
    pingAll: jest.fn(),
    regions: jest.fn(() => ['eg']),
    destroyAll: jest.fn(),
  };

  return {
    knex: knex as unknown as ShardedKnex,
    database,
    transaction,
    query,
    setResult: transactionDoubles.setResult,
  };
}

export function createRedisMock() {
  const pipeline = {
    del: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
    geoadd: jest.fn().mockReturnThis(),
    hgetall: jest.fn().mockReturnThis(),
    hincrby: jest.fn().mockReturnThis(),
    hmset: jest.fn().mockReturnThis(),
    sadd: jest.fn().mockReturnThis(),
    srem: jest.fn().mockReturnThis(),
    zrem: jest.fn().mockReturnThis(),
  };
  return {
    pipeline: jest.fn(() => pipeline),
    call: jest.fn(),
    del: jest.fn(),
    expire: jest.fn(),
    hget: jest.fn(),
    sadd: jest.fn(),
    sismember: jest.fn(),
    srem: jest.fn(),
    pipelineMock: pipeline,
  };
}
