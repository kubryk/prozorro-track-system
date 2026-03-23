import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common'; // Added import for ValidationPipe
import 'dotenv/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS for frontend integration
  app.enableCors({
    origin: '*', // For development. Consider restricting in production.
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Accept, X-API-KEY',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Prozorro Track System API')
    .setDescription(
      'API для пошуку тендерів і контрактів, запуску аналізу документів, AI-витягу позицій, AI-аудиту та отримання usage/cost telemetry.',
    )
    .setVersion('1.0')
    .addTag('app', 'Службові маршрути API')
    .addTag('search', 'Пошук тендерів, контрактів і агрегована статистика')
    .addTag('prompt-settings', 'Редаговані AI промпти для extraction та audit pipeline')
    .addTag('contract-analysis', 'Запуск аналізу контракту, статуси, деталі, AI витяг та аудит')
    .addTag('contract-usage', 'Токени, OCR сторінки та estimated cost по контракту')
    .addApiKey({ type: 'apiKey', name: 'X-API-KEY', in: 'header' }, 'api-key')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
