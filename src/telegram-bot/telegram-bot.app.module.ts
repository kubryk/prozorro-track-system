import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SearchModule } from '../search/search.module';
import { TelegramBotModule } from './telegram-bot.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    SearchModule,
    TelegramBotModule,
  ],
})
export class TelegramBotAppModule {}
