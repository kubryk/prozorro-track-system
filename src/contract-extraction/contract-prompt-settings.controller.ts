import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ContractPromptSettingsService } from './contract-prompt-settings.service';

@ApiTags('prompt-settings')
@ApiSecurity('api-key')
@ApiUnauthorizedResponse({
  description: 'Запит без валідного X-API-KEY',
})
@ApiBadRequestResponse({
  description: 'Некоректне тіло запиту або невалідний ключ шаблону',
})
@Controller('contract-extractions')
export class ContractPromptSettingsController {
  constructor(
    private readonly contractPromptSettingsService: ContractPromptSettingsService,
  ) {}

  @Get('prompt-settings')
  @ApiOperation({
    summary: 'Отримати AI промпти',
    description:
      'Повертає всі редаговані шаблони промптів для витягу позицій, аудиту, нормалізації аудиту та фінального звіту.',
  })
  @ApiResponse({
    status: 200,
    description: 'Список шаблонів з поточними і стандартними значеннями',
  })
  async getPromptSettings() {
    return {
      templates: await this.contractPromptSettingsService.getTemplates(),
    };
  }

  @Put('prompt-settings')
  @ApiOperation({
    summary: 'Оновити AI промпти',
    description:
      'Оновлює один або кілька шаблонів промптів. Підтримує як збереження нового content, так і reset до стандартного значення.',
  })
  @ApiBody({
    description: 'Масив змінених шаблонів промптів',
    schema: {
      type: 'object',
      properties: {
        templates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', example: 'gemini_contract_extraction_system' },
              content: { type: 'string', example: 'Ти витягуєш предмети договору...' },
              reset: { type: 'boolean', example: false },
            },
            required: ['key'],
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Оновлені шаблони промптів',
  })
  async updatePromptSettings(
    @Body()
    body: {
      templates?: Array<{
        key: string;
        content?: string | null;
        reset?: boolean;
      }>;
    },
  ) {
    return this.contractPromptSettingsService.updateTemplates(body?.templates ?? []);
  }
}
