import { Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ContractExtractionService } from './contract-extraction.service';

@ApiTags('contract-extraction')
@ApiSecurity('api-key')
@Controller('contract-extractions')
export class ContractExtractionController {
  constructor(
    private readonly contractExtractionService: ContractExtractionService,
  ) {}

  @Post('contracts/:contractRef/run')
  @ApiOperation({
    summary:
      'Queue Google OCR extraction for a selected contract using internal id or public contractID',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 201,
    description: 'Extraction job has been queued or returned from cache',
  })
  async runExtraction(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.queueContractExtraction(contractRef);
  }

  @Get('contracts/:contractRef/status')
  @ApiOperation({
    summary: 'Get the latest Google OCR extraction status for a selected contract',
  })
  @ApiParam({
    name: 'contractRef',
    description: 'Internal contract id or public contractID',
  })
  @ApiResponse({
    status: 200,
    description: 'Current extraction state and latest result if available',
  })
  async getStatus(@Param('contractRef') contractRef: string) {
    return this.contractExtractionService.getContractExtractionStatus(contractRef);
  }
}
