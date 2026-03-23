import { Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ContractExtractionService } from './contract-extraction.service';

@ApiTags('contract-analysis')
@ApiSecurity('api-key')
@ApiUnauthorizedResponse({
  description: 'Запит без валідного X-API-KEY',
})
@ApiBadRequestResponse({
  description: 'Некоректний contractRef',
})
@Controller('contract-extractions')
export class ContractAnalysisController {
  constructor(
    private readonly contractExtractionService: ContractExtractionService,
  ) {}

  @Post('contracts/:contractRef/run')
  @ApiOperation({
    summary: 'Запустити повний аналіз контракту',
    description:
      'Ставить у чергу повний pipeline: витяг тексту з документів, AI витяг позицій, AI аудит позицій і фінальний аудит договору.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 201,
    description: 'Pipeline поставлено в чергу або повернуто поточний активний run',
  })
  async runExtraction(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.queueContractExtraction(contractRef);
  }

  @Get('contracts/:contractRef/status')
  @ApiOperation({
    summary: 'Статус витягу з документів',
    description:
      'Повертає статус останнього document extraction run для контракту, включно з документами, витягнутим текстом і usage summary.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 200,
    description: 'Поточний state і останній result document extraction',
  })
  async getStatus(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.getContractExtractionStatus(contractRef);
  }

  @Post('contracts/:contractRef/ai-extract')
  @ApiOperation({
    summary: 'Запустити AI витяг позицій',
    description:
      'Запускає Gemini extraction поверх уже витягнутого тексту документів і повертає останній run з items та usage.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 201,
    description: 'Останній AI extraction run для контракту',
  })
  async runAiExtraction(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.runContractAiExtraction(contractRef);
  }

  @Get('contracts/:contractRef/ai-status')
  @ApiOperation({
    summary: 'Статус AI витягу позицій',
    description:
      'Повертає стан останнього Gemini extraction run разом із витягнутими позиціями та usage telemetry.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 200,
    description: 'Поточний state і останній result AI extraction',
  })
  async getAiStatus(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.getContractAiExtractionStatus(contractRef);
  }

  @Post('contracts/:contractRef/ai-audit')
  @ApiOperation({
    summary: 'Запустити AI аудит контракту',
    description:
      'Запускає grounded Gemini audit по позиціях, структуровану нормалізацію і фінальний аудит всього договору.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 201,
    description: 'Останній AI audit run для контракту',
  })
  async runAiAudit(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.runContractAiAudit(contractRef);
  }

  @Get('contracts/:contractRef/ai-audit-status')
  @ApiOperation({
    summary: 'Статус AI аудиту',
    description:
      'Повертає останній AI audit run з item-level risk, фінальним audit report, джерелами і usage telemetry.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 200,
    description: 'Поточний state і останній result AI audit',
  })
  async getAiAuditStatus(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.getContractAiAuditStatus(contractRef);
  }

  @Get('contracts/:contractRef/report')
  @ApiOperation({
    summary: 'Структурований звіт аудиту договору',
    description:
      'Повертає готовий reportDocument JSON з 5 блоками для окремої веб-сторінки, бота або експорту.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 200,
    description: 'Останній збережений структурований звіт аудиту договору',
  })
  async getAuditReport(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.getContractAuditReport(contractRef);
  }

  @Get('contracts/:contractRef/details')
  @ApiOperation({
    summary: 'Детальний payload контракту',
    description:
      'Повертає повний payload для сторінки контракту: локальні дані, тендер, документи, extraction runs, audit runs, resolved items і processing usage.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 200,
    description: 'Детальна відповідь для contract detail page',
  })
  async getDetails(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.getContractDetail(contractRef);
  }
}
