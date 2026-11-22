/**
 * mydata.controller.ts — REST endpoints for myDATA (AADE) management (Greece)
 *
 * Endpoints:
 *   GET  /v1/mydata/health            — CloudCashbox SaaS Echo-Check (ist die API erreichbar?)
 *   GET  /v1/mydata/stats             — Statistik (submitted/pending/failed/cancelled)
 *   POST /v1/mydata/cancel            — Beleg stornieren (CancelInvoice bei myDATA)
 *   GET  /v1/mydata/receipt/:orderId  — Belegdaten für Bon-Druck abrufen
 *
 * License: AGPL-3.0-only (same as OrderRestro)
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import type { SessionUser } from '@nodedr-restaurant/types';
import { Auth } from '../../common/decorators/auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BranchAccessService } from '../../common/services/branch-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MyDataService } from './mydata.service';
import { z } from 'zod';

const cancelSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

const orderIdSchema = z.string().uuid();

@ApiTags('mydata')
@Controller('v1/mydata')
export class MyDataController {
  constructor(
    private readonly service: MyDataService,
    private readonly branchAccess: BranchAccessService,
    private readonly prisma: PrismaService,
  ) {}

  @Auth('settings.manage')
  @Get('health')
  @ApiOperation({ summary: 'Prüft, ob die fiskaltrust CloudCashbox SaaS erreichbar ist' })
  async health() {
    const ok = await this.service.health();
    return {
      enabled: this.service.isEnabled,
      sandbox: this.service.isSandbox,
      cloudReachable: ok,
    };
  }

  @Auth('reports.access')
  @Get('stats')
  @ApiQuery({ name: 'branchId', required: false })
  @ApiOperation({ summary: 'Statistik: übermittelte/ausstehende/fehlgeschlagene Belege' })
  async stats(
    @CurrentUser() user: SessionUser,
    @Query('branchId') branchId?: string,
  ) {
    if (branchId) {
      await this.branchAccess.assertAccess(user.restaurantId, branchId);
    }
    return this.service.stats(branchId);
  }

  @Auth('settings.manage')
  @Post('cancel')
  @ApiOperation({ summary: 'Storniert einen Beleg bei myDATA (CancelInvoice)' })
  async cancel(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ) {
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'Invalid cancel request: { orderId: UUID, reason?: string } required',
      );
    }

    // Resolve the order's branchId before asserting access — the order
    // belongs to a branch, and we must check the user has access to THAT
    // branch, not treat the orderId as a branchId (which was the bug).
    const order = await this.prisma.order.findUnique({
      where: { id: parsed.data.orderId },
      select: { branchId: true },
    });
    if (!order) {
      throw new BadRequestException(`Order ${parsed.data.orderId} not found`);
    }
    await this.branchAccess.assertAccess(user.restaurantId, order.branchId);

    await this.service.cancelReceipt(parsed.data.orderId, parsed.data.reason);
    return { success: true, message: 'Receipt cancellation submitted to myDATA' };
  }

  @Auth('reports.access')
  @Get('receipt/:orderId')
  @ApiOperation({ summary: 'Belegdaten für Bon-Druck abrufen (MARK, QR-Code, UID)' })
  async receipt(
    @CurrentUser() user: SessionUser,
    @Param('orderId') orderId: string,
  ) {
    const parsedId = orderIdSchema.safeParse(orderId);
    if (!parsedId.success) {
      throw new BadRequestException('Invalid orderId — must be a UUID');
    }
    // Same fix: resolve branchId from the order, then assert access.
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { branchId: true },
    });
    if (!order) {
      throw new BadRequestException(`Order ${orderId} not found`);
    }
    await this.branchAccess.assertAccess(user.restaurantId, order.branchId);

    const data = await this.service.getReceiptData(orderId);
    if (!data) {
      return { submitted: false };
    }
    return { submitted: true, ...data };
  }
}
