import { Controller, Get, Param } from '@nestjs/common';
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

@ApiTags('contract-usage')
@ApiSecurity('api-key')
@ApiUnauthorizedResponse({
  description: 'Запит без валідного X-API-KEY',
})
@ApiBadRequestResponse({
  description: 'Некоректний contractRef',
})
@Controller('contract-extractions')
export class ContractUsageController {
  constructor(
    private readonly contractExtractionService: ContractExtractionService,
  ) {}

  @Get('contracts/:contractRef/usage')
  @ApiOperation({
    summary: 'Usage і estimated cost по контракту',
    description:
      'Повертає структуровану telemetry-аналітику по останніх run-ах: токени Gemini, OCR сторінки, grounded search count і estimated cost.',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 200,
    description: 'Структуроване usage summary для extraction, AI extraction, AI audit і total',
  })
  async getUsage(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.getContractUsage(contractRef);
  }
}
