import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderRepository } from '../order/repository/order.repository';
import { OrderEntity } from '../order/entity/order.entity';
import { AgentEarningRepository } from './repository/agent-earning.repository';
import { AgentEarningEntity } from './entity/agent-earning.entity';
import { AGENT_ERRORS } from './agent.constants';
import { ListEarningsOptions, ListTasksOptions } from './agent.service.types';
import {
  buildPaginationResult,
  PaginationMeta,
} from '../../lib/pagination/cursor-pagination';
import { BranchClient } from '../../lib/core-client/branch.client';
import { CoreBranchMetadata } from '../../lib/core-client/branch.client.types';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly orderRepo: OrderRepository,
    private readonly earningRepo: AgentEarningRepository,
    private readonly branchClient: BranchClient,
  ) {}

  // ─── GET /agents/tasks?status= ────────────────────────────────────────────
  async listTasks(
    region: string,
    agentId: number,
    options: ListTasksOptions,
  ): Promise<{ data: Array<OrderEntity & { branch?: CoreBranchMetadata }>; meta: PaginationMeta }> {
    const orders = await this.orderRepo.findByAgent(
      region,
      agentId,
      options.status,
      options.params,
    );

    const branchIds = [...new Set(orders.map((o) => Number(o.branchId)))];
    const branches = await this.branchClient.getBranchesBulk(branchIds);
    const branchMap = new Map(branches.map((b) => [b.id, b]));

    const augmentedOrders = orders.map((order) => {
      return {
        ...order,
        branch: branchMap.get(Number(order.branchId)),
      };
    });

    return buildPaginationResult(augmentedOrders, options.params.limit, options.params.apiSortBy);
  }

  // ─── GET /agents/earnings?from=&to= ──────────────────────────────────────
  async listEarnings(
    region: string,
    agentId: number,
    options: ListEarningsOptions,
  ): Promise<{
    items: Array<AgentEarningEntity & { orderPublicId: string }>;
    sum: number;
    count: number;
    currency: string;
    from: Date;
    to: Date;
    nextCursor: string | null;
  }> {
    const earningParams = {
      ...options.params,
      sortBy: 'earned_at',
      apiSortBy: 'earnedAt',
      sortOrder: 'desc' as const,
    };
    const filters = [
      { field: 'ae.earned_at', operator: 'gte' as const, value: options.from.toISOString() },
      { field: 'ae.earned_at', operator: 'lt' as const, value: options.to.toISOString() },
    ];
    const items = await this.earningRepo.findByAgent(
      region,
      agentId,
      filters,
      earningParams,
    );
    const totals = await this.earningRepo.sumByAgent(
      region,
      agentId,
      options.from,
      options.to,
    );

    const paginatedResult = buildPaginationResult(
      items,
      options.params.limit,
      'earnedAt',
    );

    return {
      items: paginatedResult.data,
      sum: totals.sum,
      count: totals.count,
      currency: totals.currency,
      from: options.from,
      to: options.to,
      nextCursor: paginatedResult.meta.nextCursor,
    };
  }

  /**
   * Verify the calling agent owns the order's delivery assignment.
   * Returns the order if authorized.
   */
  async assertAgentOwnership(
    region: string,
    publicId: string,
    agentUserId: number,
  ): Promise<OrderEntity> {
    const order = await this.orderRepo.findByPublicId(region, publicId);
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (Number(order.deliveryAgentId) !== agentUserId) {
      throw new ForbiddenException(AGENT_ERRORS.NOT_ASSIGNED);
    }
    return order;
  }
}
