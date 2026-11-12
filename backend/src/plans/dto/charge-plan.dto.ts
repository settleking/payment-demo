import { IsString, Length } from 'class-validator';

/** Admin: charge an on-demand plan for one class the customer attended. */
export class ChargePlanDto {
  @IsString()
  @Length(1, 40)
  classId!: string;
}
