import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Logger,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../lib/middleware/guards/jwtGuard';
import { PermissionsGuard } from '../../lib/middleware/guards/permissions.guard';
import { RequirePermissions } from '../../lib/decorators/permissions.decorator';
import { AgentService } from './agent.service';
import { PresenceService } from './presence.service';
import { AssignmentService } from '../order/assignment.service';
import { OrderService } from '../order/order.service';
import { OrderRepository } from '../order/repository/order.repository';
import { PresenceLocationRequestDTO } from './dto/presence.request.dto';
import { PresenceResponseDTO } from './dto/presence.response.dto';
import {
  DeliveryAction,
  UpdateDeliveryStatusRequestDTO,
  AssignAgentRequestDTO,
} from './dto/agent.request.dto';
import {
  AgentEarningsResponseDTO,
  AssignmentResponseDTO,
  DeliveryTaskResponseDTO,
} from './dto/agent.response.dto';
import { OrderStatusResponseDTO } from '../order/dto/order.response.dto';
import { AGENT_ERRORS } from './agent.constants';
import { PRESENCE_ERRORS } from './presence.constants';
import { OrderStatus } from '../order/enums';
import {
  parsePaginationQuery,
} from '../../lib/pagination/query-parser';
import {
  buildPaginationResult,
} from '../../lib/pagination/cursor-pagination';

const TASK_COLUMN_MAP: Record<string, string> = { createdAt: 'created_at' };

@Controller()
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly presenceService: PresenceService,
    private readonly assignmentService: AssignmentService,
    private readonly orderService: OrderService,
    private readonly orderRepo: OrderRepository,
  ) {}

  // ═══ Presence endpoints ═══════════════════════════════════════════════════

  @Post('agents/presence/online')
  @UseGuards(JwtAuthGuard)
  async goOnline(
    @Req() req: Request,
    @Body() body: PresenceLocationRequestDTO,
  ): Promise<PresenceResponseDTO> {
    this.assertAgent(req);
    const region = this.requireRegion(req);
    await this.presenceService.goOnline(region, req.user!.userId, body.lat, body.lng);
    return PresenceResponseDTO.success();
  }

  @Post('agents/presence/offline')
  @UseGuards(JwtAuthGuard)
  async goOffline(@Req() req: Request): Promise<PresenceResponseDTO> {
    this.assertAgent(req);
    const region = this.requireRegion(req);
    const result = await this.presenceService.goOffline(region, req.user!.userId);

    // If the agent had an assigned order, trigger reassignment
    if (result.reassignOrderId && result.reassignOrderCreatedAt) {
      // Clear the assignment first, then re-run the assignment loop
      this.assignmentService
        .reassign(
          result.reassignOrderRegion ?? region,
          result.reassignOrderId,
          result.reassignOrderCreatedAt,
        )
        .catch((err) => {
          this.logger.error(
            `Reassignment after offline failed: ${(err as Error).message}`,
          );
        });
    }

    return PresenceResponseDTO.success();
  }

  @Post('agents/presence/ping')
  @UseGuards(JwtAuthGuard)
  async ping(
    @Req() req: Request,
    @Body() body: PresenceLocationRequestDTO,
  ): Promise<PresenceResponseDTO> {
    this.assertAgent(req);
    const region = this.requireRegion(req);
    await this.presenceService.ping(region, req.user!.userId, body.lat, body.lng);
    return PresenceResponseDTO.success();
  }

  // ═══ Task list ══
  // ══════════════════════════════════════════════════════════

  @Get('agents/tasks')
  @UseGuards(JwtAuthGuard)
  async listTasks(@Req() req: Request) {
    this.assertAgent(req);
    const region = this.requireRegion(req);
    const status = req.query.status as string | undefined;
    if (status && !Object.values(OrderStatus).includes(status as OrderStatus)) {
      throw new BadRequestException(`Invalid status "${status}"`);
    }
    const params = parsePaginationQuery(
      { ...req.query, sortBy: 'createdAt', sortOrder: 'desc' },
      TASK_COLUMN_MAP,
    );
    const result = await this.agentService.listTasks(
      region,
      req.user!.userId,
      { status, params, filters: [] },
    );
    const dtos = result.data.map(DeliveryTaskResponseDTO.from);
    return { data: dtos, meta: result.meta };
  }

  // ═══ Earnings ═════════════════════════════════════════════════════════════

  @Get('agents/earnings')
  @UseGuards(JwtAuthGuard)
  async listEarnings(@Req() req: Request) {
    this.assertAgent(req);
    const region = this.requireRegion(req);

    const now = new Date();
    const from = req.query.from
      ? this.parseDate(req.query.from as string, 'from')
      : new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
    const to = req.query.to
      ? this.parseDate(req.query.to as string, 'to')
      : now;
    if (from >= to) {
      throw new BadRequestException('"from" must be before "to"');
    }

    const params = parsePaginationQuery(
      { ...req.query, sortBy: 'earnedAt', sortOrder: 'desc' },
      { earnedAt: 'earned_at' },
    );

    const result = await this.agentService.listEarnings(
      region,
      req.user!.userId,
      { from, to, params },
    );

    return AgentEarningsResponseDTO.from({
      from: result.from,
      to: result.to,
      items: result.items,
      sum: result.sum,
      count: result.count,
      currency: result.currency,
      nextCursor: result.nextCursor,
    });
  }

  // ═══ Delivery status (agent actions on orders) ════════════════════════════

  @Patch('orders/:publicId/delivery-status')
  @UseGuards(JwtAuthGuard)
  async updateDeliveryStatus(
    @Req() req: Request,
    @Param('publicId', new ParseUUIDPipe({ version: '4' })) publicId: string,
    @Body() body: UpdateDeliveryStatusRequestDTO,
  ): Promise<OrderStatusResponseDTO> {
    this.assertAgent(req);
    const region = this.requireRegion(req);
    const agentId = req.user!.userId;

    const order = await this.agentService.assertAgentOwnership(
      region,
      publicId,
      agentId,
    );

    switch (body.status) {
      case DeliveryAction.ACCEPT:
        // Acceptance is just a confirmation — order stays ASSIGNED.
        // The assignment timeout timer is cleared (no timer implemented in v1;
        // the agent simply calls this within the timeout window).
        return OrderStatusResponseDTO.from(order);

      case DeliveryAction.PICKUP:
        return this.handlePickup(region, order);

      case DeliveryAction.DELIVER:
        return this.handleDeliver(region, order);

      case DeliveryAction.REJECT:
        await this.handleReject(region, order, agentId);
        // After rejection the order goes back to READY
        return OrderStatusResponseDTO.from(order);

      default:
        throw new BadRequestException(AGENT_ERRORS.INVALID_DELIVERY_STATUS);
    }
  }

  // ═══ Admin assign / reassign ══════════════════════════════════════════════


  @Post('orders/:publicId/assign')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('deliveries', 'assign')
  async adminAssign(
    @Req() req: Request,
    @Param('publicId', new ParseUUIDPipe({ version: '4' })) publicId: string,
    @Body() body: AssignAgentRequestDTO,
  ): Promise<AssignmentResponseDTO> {
    const region = this.requireRegion(req);
    const order = await this.orderRepo.findByPublicId(region, publicId);
    if (!order) throw new BadRequestException('Order not found');

    const updated = await this.assignmentService.manualAssign(
      region,
      order.id,
      order.createdAt,
      body.agentId,
    );
    if (!updated) {
      throw new BadRequestException(AGENT_ERRORS.ORDER_NOT_ASSIGNABLE);
    }
    return AssignmentResponseDTO.from(updated);
  }

  @Post('orders/:publicId/reassign')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('deliveries', 'assign')
  async adminReassign(
    @Req() req: Request,
    @Param('publicId', new ParseUUIDPipe({ version: '4' })) publicId: string,
  ): Promise<{ ok: boolean; assigned: boolean }> {
    const region = this.requireRegion(req);
    const order = await this.orderRepo.findByPublicId(region, publicId);
    if (!order) throw new BadRequestException('Order not found');

    const result = await this.assignmentService.reassign(
      region,
      order.id,
      order.createdAt,
    );
    return { ok: true, assigned: result.assigned };
  }

  // ═══ Private helpers ══════════════════════════════════════════════════════

  private async handlePickup(
    region: string,
    order: any,
  ): Promise<OrderStatusResponseDTO> {
    if (order.status !== OrderStatus.ASSIGNED || order.accepted_at === null) {
      throw new ConflictException(`Order must be in assigned state to pickup, currently ${order.status}`);
    }
    const updated = await this.orderService.updateStatusInternal(
      region,
      order.id,
      order.createdAt,
      OrderStatus.PICKED,
      'picked_at',
    );
    return OrderStatusResponseDTO.from(updated);
  }

  private async handleDeliver(
    region: string,
    order: any,
  ): Promise<OrderStatusResponseDTO> {
    if (order.status !== OrderStatus.PICKED) {
      throw new ConflictException(`Order must be in picked state to deliver, currently ${order.status}`);
    }
    const updated = await this.orderService.updateStatusInternal(
      region,
      order.id,
      order.createdAt,
      OrderStatus.DELIVERED,
      'delivered_at',
    );
    return OrderStatusResponseDTO.from(updated);
  }

  private async handleReject(
    region: string,
    order: any,
    agentId: number,
  ): Promise<void> {
    await this.assignmentService.handleAgentReject(
      region,
      order.id,
      order.createdAt,
      agentId,
    );
  }

  private assertAgent(req: Request): void {
    if (req.user?.role !== 'delivery_agent') {
      throw new ForbiddenException(PRESENCE_ERRORS.AGENTS_ONLY);
    }
  }

  private requireRegion(req: Request): string {
    const region = req.region;
    if (!region) {
      throw new BadRequestException(PRESENCE_ERRORS.REGION_REQUIRED);
    }
    return region;
  }

  private parseDate(value: string, field: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid ${field} date`);
    }
    return parsed;
  }
}
