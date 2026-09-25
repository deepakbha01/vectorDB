import { IsOptional, IsString, Length } from 'class-validator';

/** Form fields sent with an uploaded simulation file. */
export class SimulationUploadDto {
  /** Defaults to the file name. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  label?: string;
}
