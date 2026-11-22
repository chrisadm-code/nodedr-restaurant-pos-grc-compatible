/**
 * mydata.module.ts — NestJS module for myDATA (AADE) fiscalization (Greece)
 *
 * Registers MyDataService and MyDataController.
 * Exports MyDataService so OrdersModule can call it during checkout.
 *
 * Architecture: parallel to VerifactuModule (Spain).
 *   - Spain:    AEAT VeriFactu API → QR with AEAT URL
 *   - Greece:   fiskaltrust CloudCashbox SaaS → myDATA submission → MARK + QR
 *
 * No HttpModule needed — the service uses native fetch (Node 18+).
 *
 * License: AGPL-3.0-only (same as OrderRestro)
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { MyDataController } from './mydata.controller';
import { MyDataService } from './mydata.service';

@Module({
  imports: [ConfigModule, AuditModule, PrismaModule],
  controllers: [MyDataController],
  providers: [MyDataService],
  exports: [MyDataService],
})
export class MyDataModule {}
