import { IsIn, IsOptional } from 'class-validator';

export class AlertsQueryDto {
  @IsOptional()
  @IsIn(['open', 'all'])
  status?: 'open' | 'all';
}
