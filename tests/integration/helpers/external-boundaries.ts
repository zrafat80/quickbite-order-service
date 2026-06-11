import { createHmac } from 'crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'http';

export interface TestBranch {
  id: number;
  restaurantId: number;
  restaurantStatus: string;
  restaurantName: string;
  countryCode: string;
  isActive: boolean;
  acceptOrders: boolean;
  deliveryFee: number;
  commission: number;
  currency: string;
  lat: number;
  lng: number;
  label: string;
  addressText: string;
}

export interface TestProduct {
  productId: number;
  name: string;
  imageUrl: string | null;
  price: number;
  stock: number;
  isAvailable: boolean;
}

export interface TestAddress {
  id: number;
  userId: number;
  label: string;
  country: string;
  city: string;
  street: string;
  building: string | null;
  apartmentNumber: string | null;
  type: string;
  lat: number;
  lng: number;
}

export class MemoryCacheManager {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  reset(): void {
    this.values.clear();
  }
}

export class MemoryCacheProvider {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async trySet(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) return false;
    this.values.set(key, value);
    return true;
  }

  reset(): void {
    this.values.clear();
  }
}

export class MemoryRedis {
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly geo = new Map<string, Map<string, { lng: number; lat: number }>>();

  pipeline(): any {
    const operations: Array<() => Promise<unknown>> = [];
    const pipeline: any = {};
    const methods = [
      'geoadd',
      'hmset',
      'srem',
      'zrem',
      'del',
      'hgetall',
      'hincrby',
      'sadd',
    ];
    for (const method of methods) {
      pipeline[method] = (...args: unknown[]) => {
        operations.push(() => (this as any)[method](...args));
        return pipeline;
      };
    }
    pipeline.exec = async () =>
      Promise.all(
        operations.map(async (operation) => {
          try {
            return [null, await operation()];
          } catch (error) {
            return [error, null];
          }
        }),
      );
    return pipeline;
  }

  async geoadd(key: string, lng: number, lat: number, member: string): Promise<number> {
    const members = this.geo.get(key) ?? new Map();
    members.set(String(member), { lng: Number(lng), lat: Number(lat) });
    this.geo.set(key, members);
    return 1;
  }

  async hmset(
    key: string,
    fieldOrValues: string | Record<string, string>,
    value?: string,
  ): Promise<'OK'> {
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    if (typeof fieldOrValues === 'string') {
      hash.set(fieldOrValues, String(value ?? ''));
    } else {
      for (const [field, fieldValue] of Object.entries(fieldOrValues)) {
        hash.set(field, String(fieldValue));
      }
    }
    this.hashes.set(key, hash);
    return 'OK';
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hincrby(key: string, field: string, delta: number): Promise<number> {
    const next = Number((await this.hget(key, field)) ?? 0) + Number(delta);
    await this.hmset(key, field, String(next));
    return next;
  }

  async sadd(key: string, member: string): Promise<number> {
    const values = this.sets.get(key) ?? new Set<string>();
    const size = values.size;
    values.add(String(member));
    this.sets.set(key, values);
    return values.size > size ? 1 : 0;
  }

  async srem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(String(member)) ? 1 : 0;
  }

  async sismember(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.has(String(member)) ? 1 : 0;
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.geo.get(key)?.delete(String(member)) ? 1 : 0;
  }

  async zcard(key: string): Promise<number> {
    return this.geo.get(key)?.size ?? 0;
  }

  async del(key: string): Promise<number> {
    let deleted = 0;
    deleted += this.strings.delete(key) ? 1 : 0;
    deleted += this.hashes.delete(key) ? 1 : 0;
    deleted += this.sets.delete(key) ? 1 : 0;
    deleted += this.geo.delete(key) ? 1 : 0;
    return deleted;
  }

  async expire(): Promise<number> {
    return 1;
  }

  async call(command: string, ...args: string[]): Promise<unknown[]> {
    if (command.toUpperCase() !== 'GEOSEARCH') return [];
    const key = args[0];
    const lng = Number(args[2]);
    const lat = Number(args[3]);
    const radius = Number(args[5]);
    const rows = [...(this.geo.get(key) ?? new Map()).entries()]
      .map(([member, point]) => ({
        member,
        distance: distanceMeters(lat, lng, point.lat, point.lng),
      }))
      .filter((row) => row.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
    return rows.map((row) => [row.member, String(row.distance)]);
  }

  duplicate(): MemoryRedis {
    return this;
  }

  on(): this {
    return this;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  disconnect(): void {}

  reset(): void {
    this.strings.clear();
    this.hashes.clear();
    this.sets.clear();
    this.geo.clear();
  }
}

export class BoundaryAmqpConnection {
  private readonly broker = {
    async connect() {},
    async close() {},
    async declareTopology() {},
    async consume() {},
    async publish() {},
  };

  getBroker() {
    return this.broker;
  }
}

export class BoundaryOrderEventsBroker {
  readonly published: Array<{ routingKey: string; body: unknown }> = [];

  async ensureConnected(): Promise<void> {}

  async publish(routingKey: string, body: Buffer): Promise<void> {
    this.published.push({
      routingKey,
      body: JSON.parse(body.toString('utf8')),
    });
  }

  reset(): void {
    this.published.length = 0;
  }
}

export class BoundaryWsGateway {
  readonly emitted: Array<{ channel: string; event: string; payload: unknown }> = [];
  readonly server = {
    to: (channel: string) => ({
      emit: (event: string, payload: unknown) => {
        this.emitted.push({ channel, event, payload });
      },
    }),
  };

  reset(): void {
    this.emitted.length = 0;
  }
}

export class ExternalBoundaryServer {
  readonly branches = new Map<number, TestBranch>();
  readonly products = new Map<number, Map<number, TestProduct>>();
  readonly addresses = new Map<number, TestAddress>();
  readonly permissions = new Map<string, string[]>();
  readonly requests: Array<{ method: string; path: string; body: unknown }> = [];
  private server?: Server;
  private sessionCounter = 0;
  private refundCounter = 0;
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind integration boundary server');
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    this.reset();
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
  }

  reset(): void {
    this.requests.length = 0;
    this.sessionCounter = 0;
    this.refundCounter = 0;
    this.branches.clear();
    this.products.clear();
    this.addresses.clear();
    this.permissions.clear();

    this.branches.set(2, {
      id: 2,
      restaurantId: 3,
      restaurantStatus: 'active',
      restaurantName: 'Quick Kitchen',
      countryCode: 'EG',
      isActive: true,
      acceptOrders: true,
      deliveryFee: 100,
      commission: 2000,
      currency: 'EGP',
      lat: 30.0444,
      lng: 31.2357,
      label: 'Downtown',
      addressText: '1 Tahrir Square, Cairo',
    });
    this.products.set(
      2,
      new Map([
        [
          12,
          {
            productId: 12,
            name: 'Chicken Sandwich',
            imageUrl: null,
            price: 500,
            stock: 20,
            isAvailable: true,
          },
        ],
        [
          13,
          {
            productId: 13,
            name: 'Fries',
            imageUrl: null,
            price: 200,
            stock: 20,
            isAvailable: true,
          },
        ],
      ]),
    );
    this.addresses.set(9, {
      id: 9,
      userId: 7,
      label: 'Home',
      country: 'Egypt',
      city: 'Cairo',
      street: 'Nile Street',
      building: '12',
      apartmentNumber: '4',
      type: 'home',
      lat: 30.05,
      lng: 31.24,
    });
    this.addresses.set(10, {
      ...this.addresses.get(9)!,
      id: 10,
      userId: 8,
      label: 'Other Customer',
    });
    this.permissions.set('owner', [
      'orders:read',
      'orders:accept',
      'orders:update',
      'orders:cancel',
      'deliveries:assign',
      'finance:read',
      'finance:payout_create',
    ]);
    this.permissions.set('branch_manager', [
      'orders:read',
      'orders:accept',
      'orders:update',
      'orders:cancel',
      'deliveries:assign',
      'finance:read',
    ]);
    this.permissions.set('staff', ['orders:read']);
  }

  webhookSignature(data: Record<string, unknown>): string {
    const keys = Array.isArray(data.signatureKeys)
      ? [...(data.signatureKeys as string[])].sort()
      : [];
    const payload = keys
      .map(
        (key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(
            stringifySignatureValue(data[key]),
          )}`,
      )
      .join('&');
    return createHmac('sha256', process.env.KASHIER_WEBHOOK_SECRET!)
      .update(payload)
      .digest('hex');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', this.baseUrl);
    const body = await readJson(req);
    this.requests.push({ method, path: url.pathname, body });

    if (method === 'POST' && url.pathname === '/v3/payment/sessions') {
      this.sessionCounter += 1;
      return json(res, 200, {
        _id: `session-${this.sessionCounter}`,
        sessionUrl: `${this.baseUrl}/checkout/session-${this.sessionCounter}`,
        expireAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    }

    if (method === 'PUT' && /^\/orders\/[^/]+\/$/.test(url.pathname)) {
      this.refundCounter += 1;
      return json(res, 200, {
        status: 'SUCCESS',
        response: {
          status: 'SUCCESS',
          transactionId: `refund-provider-${this.refundCounter}`,
        },
      });
    }

    const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (method === 'GET' && roleMatch) {
      const role = decodeURIComponent(roleMatch[1]);
      return json(res, 200, {
        data: { role, permissions: this.permissions.get(role) ?? [] },
      });
    }

    const productMatch = url.pathname.match(
      /^\/api\/internal\/branches\/(\d+)\/products$/,
    );
    if (method === 'GET' && productMatch) {
      const branchId = Number(productMatch[1]);
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      const branchProducts = this.products.get(branchId) ?? new Map();
      return json(res, 200, {
        data: ids.map((id) => branchProducts.get(id)).filter(Boolean),
      });
    }

    const reserveMatch = url.pathname.match(
      /^\/api\/internal\/branches\/(\d+)\/(reserve|release)-stock$/,
    );
    if (method === 'POST' && reserveMatch) {
      const branchId = Number(reserveMatch[1]);
      const action = reserveMatch[2];
      const items = ((body as any)?.items ?? []) as Array<{
        productId: number;
        quantity: number;
      }>;
      const branchProducts = this.products.get(branchId) ?? new Map();
      if (action === 'reserve') {
        const insufficient = items
          .map((item) => {
            const product = branchProducts.get(item.productId);
            const available = product?.stock ?? 0;
            return available < item.quantity
              ? { ...item, requested: item.quantity, available }
              : null;
          })
          .filter(Boolean);
        if (insufficient.length > 0) {
          return json(res, 200, { data: { ok: false, insufficient } });
        }
        for (const item of items) {
          branchProducts.get(item.productId)!.stock -= item.quantity;
        }
        return json(res, 200, { data: { ok: true, reserved: items } });
      }
      for (const item of items) {
        const product = branchProducts.get(item.productId);
        if (product) product.stock += item.quantity;
      }
      return json(res, 200, { data: { ok: true, released: items } });
    }

    const branchMatch = url.pathname.match(/^\/api\/internal\/branches\/(\d+)$/);
    if (method === 'GET' && branchMatch) {
      const branch = this.branches.get(Number(branchMatch[1]));
      return branch
        ? json(res, 200, { data: branch })
        : json(res, 404, { message: 'Branch not found' });
    }

    if (method === 'GET' && url.pathname === '/api/internal/branches') {
      const ids = (url.searchParams.get('ids') ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      return json(res, 200, {
        data: ids.map((id) => this.branches.get(id)).filter(Boolean),
      });
    }

    const addressMatch = url.pathname.match(
      /^\/api\/internal\/customer-addresses\/(\d+)$/,
    );
    if (method === 'GET' && addressMatch) {
      const address = this.addresses.get(Number(addressMatch[1]));
      return address
        ? json(res, 200, { data: address })
        : json(res, 404, { message: 'Address not found' });
    }

    json(res, 404, { message: `Unhandled boundary route ${method} ${url.pathname}` });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function stringifySignatureValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
