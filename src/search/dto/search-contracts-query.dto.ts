import { Transform } from 'class-transformer';
import {
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
import { toOptionalNumber, toOptionalString } from './search-query.helpers';

const contractDateTypes = ['dateModified', 'dateSigned'] as const;

export class SearchContractsQueryDto {
  @IsOptional()
  @Transform(toOptionalString)
  @Matches(/^\d{8}(\d{2})?$/, { message: 'edrpou must contain 8 or 10 digits' })
  edrpou?: string;

  @IsOptional()
  @IsIn(['customer', 'supplier'])
  role?: 'customer' | 'supplier';

  @IsOptional()
  @Transform(toOptionalString)
  @IsString()
  status?: string;

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
