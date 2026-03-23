import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SearchModule } from '../search/search.module';
import { TelegramBotService } from './telegram-bot.service';

@Module({
  imports: [HttpModule, SearchModule],
  providers: [TelegramBotService],
})
export class TelegramBotModule {}
