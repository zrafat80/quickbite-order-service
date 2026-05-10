import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

import { v4 as uuidv4 } from 'uuid';
import { RequestContextService } from '../context/request-context.service';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const correlationId =
      (req.headers['x-correlation-id'] as string) || uuidv4();

    res.setHeader('x-correlation-id', correlationId);
    req.correlationId = correlationId;

    this.context.run(correlationId, () => {
      next();
    });
  }
}
