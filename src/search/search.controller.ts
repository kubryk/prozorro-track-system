import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiOperation, ApiResponse, ApiTags, ApiSecurity } from '@nestjs/swagger';
import { SearchService } from './search.service';

@ApiTags('search')
@ApiSecurity('api-key')
@Controller('search')
export class SearchController {
    constructor(private readonly searchService: SearchService) { }

    @Get('tenders')
    @ApiOperation({ summary: 'Search tenders by Customer EDRPOU' })
    @ApiQuery({ name: 'edrpou', required: false, type: String, description: 'Customer EDRPOU code (8 digits)' })
    @ApiQuery({ name: 'skip', required: false, type: Number, description: 'Number of items to skip' })
    @ApiQuery({ name: 'take', required: false, type: Number, description: 'Number of items to take (default: 20)' })
    @ApiResponse({ status: 200, description: 'List of matching tenders with total count' })
    async searchTenders(
        @Query('edrpou') edrpou?: string,
        @Query('skip') skip?: string,
        @Query('take') take?: string,
    ) {
        const skipNum = skip ? parseInt(skip, 10) : 0;
        const takeNum = take ? parseInt(take, 10) : 20;
        return this.searchService.searchTenders(edrpou, skipNum, takeNum);
    }

    @Get('contracts')
    @ApiOperation({ summary: 'Search contracts by Supplier EDRPOU' })
    @ApiQuery({ name: 'edrpou', required: false, type: String, description: 'Supplier EDRPOU code (8 digits)' })
    @ApiQuery({ name: 'skip', required: false, type: Number, description: 'Number of items to skip' })
    @ApiQuery({ name: 'take', required: false, type: Number, description: 'Number of items to take (default: 20)' })
    @ApiResponse({ status: 200, description: 'List of matching contracts with total count' })
    async searchContracts(
        @Query('edrpou') edrpou?: string,
        @Query('skip') skip?: string,
        @Query('take') take?: string,
    ) {
        const skipNum = skip ? parseInt(skip, 10) : 0;
        const takeNum = take ? parseInt(take, 10) : 20;
        return this.searchService.searchContracts(edrpou, skipNum, takeNum);
    }
}
