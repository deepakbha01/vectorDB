import { IsString, Length } from 'class-validator';

export class CreateIngestKeyDto {
  /** What the key is for, e.g. "prod collector - eu-west". */
  @IsString()
  @Length(1, 100)
  name: string;
}
