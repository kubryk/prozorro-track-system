import { Transform } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  toOptionalNumber,
  toOptionalString,
  toOptionalStringArray,
} from './search-query.helpers';

const tenderDateTypes = [
  'dateModified',
  'dateCreated',
  'tenderPeriodStart',
  'tenderPeriodEnd',
  'enquiryPeriodStart',
  'enquiryPeriodEnd',
  'auctionPeriodStart',
  'awardPeriodStart',
] as const;
const tenderSortTypes = [
  'default',
  'dateCreatedDesc',
  'dateCreatedAsc',
  'amountAsc',
  'amountDesc',
] as const;

export class SearchTendersQueryDto {
  @IsOptional()
  @Transform(toOptionalString)
  @Matches(/^\d{8}(\d{2})?$/, { message: 'edrpou must contain 8 or 10 digits' })
  edrpou?: string;

  @IsOptional()
  @Transform(toOptionalStringArray)
  @IsArray()
  @IsIn(['customer', 'supplier'], { each: true })
  role?: ('customer' | 'supplier')[];

  @IsOptional()
  @Transform(toOptionalStringArray)
  @IsArray()
  @IsString({ each: true })
  status?: string[];

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  priceFrom?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  priceTo?: number;

  @IsOptional()
  @IsIn(tenderDateTypes)
  dateType?: (typeof tenderDateTypes)[number];

  @IsOptional()
  @IsIn(tenderSortTypes)
  sort?: (typeof tenderSortTypes)[number];

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(0)
  skip?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}
