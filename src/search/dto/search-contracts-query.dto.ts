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

const contractDateTypes = ['dateModified', 'dateSigned'] as const;
const contractSortTypes = [
  'default',
  'amountAsc',
  'amountDesc',
  'dateSignedDesc',
  'dateSignedAsc',
] as const;

export class SearchContractsQueryDto {
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
  @IsIn(contractDateTypes)
  dateType?: (typeof contractDateTypes)[number];

  @IsOptional()
  @IsIn(contractSortTypes)
  sort?: (typeof contractSortTypes)[number];

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
