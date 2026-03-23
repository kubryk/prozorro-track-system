import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TelegramBotAppModule } from './telegram-bot/telegram-bot.app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(TelegramBotAppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const logger = new Logger('TelegramBotBootstrap');

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}. Shutting down telegram bot...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  logger.log('Telegram bot process started.');
}

void bootstrap();
