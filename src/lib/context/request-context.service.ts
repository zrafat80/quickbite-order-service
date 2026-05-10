import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

@Injectable()
export class RequestContextService {
  private static readonly storage = new AsyncLocalStorage<Map<string, string>>();

  run(correlationId: string, callback: () => void) {
    const store = new Map<string, string>().set('correlationId', correlationId);
    RequestContextService.storage.run(store, callback);
  }

  getCorrelationId(): string | undefined {
    return RequestContextService.storage.getStore()?.get('correlationId');
  }
}
