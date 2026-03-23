import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ProzorroModule } from '../prozorro/prozorro.module';

@Module({
  imports: [
    PrismaModule,
    ProzorroModule,
    BullModule.registerQueue({
      name: 'tender-processor',
    }),
  ],
  providers: [SearchService],
  controllers: [SearchController],
  exports: [SearchService],
})
export class SearchModule { }
