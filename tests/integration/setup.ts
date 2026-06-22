import 'reflect-metadata';
import { config } from 'dotenv';
import path from 'path';

config({
  path: path.resolve(process.cwd(), '.env.test'),
  override: false,
});

jest.setTimeout(60_000);
