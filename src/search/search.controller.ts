import { Controller, Get, Query } from '@nestjs/common';
import { ApiQuery, ApiOperation, ApiResponse, ApiTags, ApiSecurity } from '@nestjs/swagger';
import { SearchService, EdrpouRole } from './search.service';
import { SyncService } from '../sync/sync.service';

@ApiTags('search')
@ApiSecurity('api-key')
@Controller('search')
export class SearchController {
    constructor(
        private readonly searchService: SearchService,
        private readonly syncService: SyncService,
    ) { }

    @Get('tenders')
    @ApiOperation({ summary: 'Search tenders with filters' })
    @ApiQuery({ name: 'edrpou', required: false, type: String, description: 'EDRPOU code (8 digits)' })
    @ApiQuery({ name: 'role', required: false, enum: ['customer', 'supplier'], description: 'Role of EDRPOU: customer (замовник) or supplier (постачальник). Default: customer' })
    @ApiQuery({ name: 'status', required: false, type: String, description: 'Tender status (e.g. active, complete)' })
    @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Filter by dateModified from (ISO format, e.g. 2025-01-01)' })
    @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Filter by dateModified to (ISO format, e.g. 2025-12-31)' })
    @ApiQuery({ name: 'priceFrom', required: false, type: Number, description: 'Minimum amount' })
    @ApiQuery({ name: 'priceTo', required: false, type: Number, description: 'Maximum amount' })
    @ApiQuery({ name: 'dateType', required: false, type: String, description: 'Which date to filter by (e.g. dateModified, dateCreated, tenderPeriodStart). Default: dateModified' })
    @ApiQuery({ name: 'skip', required: false, type: Number, description: 'Number of items to skip (default: 0)' })
    @ApiQuery({ name: 'take', required: false, type: Number, description: 'Number of items to take (default: 20, max: 100)' })
    @ApiResponse({ status: 200, description: 'List of matching tenders with total count' })
    async searchTenders(
        @Query('edrpou') edrpou?: string,
        @Query('role') role?: string,
        @Query('status') status?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
        @Query('priceFrom') priceFrom?: string,
        @Query('priceTo') priceTo?: string,
        @Query('dateType') dateType?: string,
        @Query('skip') skip?: string,
        @Query('take') take?: string,
    ) {
        return this.searchService.searchTenders({
            edrpou,
            role: role as EdrpouRole,
            status,
            dateFrom,
            dateTo,
            dateType,
            priceFrom: priceFrom ? parseFloat(priceFrom) : undefined,
            priceTo: priceTo ? parseFloat(priceTo) : undefined,
            skip: skip ? parseInt(skip, 10) : 0,
            take: take ? parseInt(take, 10) : 20,
        });
    }

    @Get('contracts')
    @ApiOperation({ summary: 'Search contracts with filters' })
    @ApiQuery({ name: 'edrpou', required: false, type: String, description: 'EDRPOU code (8 digits)' })
    @ApiQuery({ name: 'role', required: false, enum: ['customer', 'supplier'], description: 'Role of EDRPOU: customer (замовник) or supplier (постачальник). Default: supplier' })
    @ApiQuery({ name: 'status', required: false, type: String, description: 'Contract status (e.g. active, terminated)' })
    @ApiQuery({ name: 'dateFrom', required: false, type: String, description: 'Filter by dateSigned from (ISO format, e.g. 2025-01-01)' })
    @ApiQuery({ name: 'dateTo', required: false, type: String, description: 'Filter by dateSigned to (ISO format, e.g. 2025-12-31)' })
    @ApiQuery({ name: 'priceFrom', required: false, type: Number, description: 'Minimum amount' })
    @ApiQuery({ name: 'priceTo', required: false, type: Number, description: 'Maximum amount' })
    @ApiQuery({ name: 'dateType', required: false, type: String, description: 'Which date to filter by (dateModified, dateSigned). Default: dateSigned' })
    @ApiQuery({ name: 'skip', required: false, type: Number, description: 'Number of items to skip (default: 0)' })
    @ApiQuery({ name: 'take', required: false, type: Number, description: 'Number of items to take (default: 20, max: 100)' })
    @ApiResponse({ status: 200, description: 'List of matching contracts with total count' })
    async searchContracts(
        @Query('edrpou') edrpou?: string,
        @Query('role') role?: string,
        @Query('status') status?: string,
        @Query('dateFrom') dateFrom?: string,
        @Query('dateTo') dateTo?: string,
        @Query('priceFrom') priceFrom?: string,
        @Query('priceTo') priceTo?: string,
        @Query('dateType') dateType?: string,
        @Query('skip') skip?: string,
        @Query('take') take?: string,
    ) {
        return this.searchService.searchContracts({
            edrpou,
            role: role as EdrpouRole,
            status,
            dateFrom,
            dateTo,
            dateType,
            priceFrom: priceFrom ? parseFloat(priceFrom) : undefined,
            priceTo: priceTo ? parseFloat(priceTo) : undefined,
            skip: skip ? parseInt(skip, 10) : 0,
            take: take ? parseInt(take, 10) : 20,
        });
    }

    @Get('admin/backfill')
    @ApiOperation({ summary: 'Backfill missing dates for existing tenders' })
    @ApiResponse({ status: 200, description: 'Backfill triggered successfully' })
    async backfill() {
        return this.syncService.backfillTenders();
    }

    @Get('stats')
    @ApiOperation({ summary: 'Get total stats for tenders and contracts' })
    @ApiResponse({ status: 200, description: 'Total counts' })
    async getStats() {
        return this.searchService.getStats();
    }
}
