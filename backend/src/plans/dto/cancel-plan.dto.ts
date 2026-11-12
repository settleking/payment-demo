import { IsEmail, MaxLength } from 'class-validator';

export class CancelPlanDto {
  @IsEmail()
  @MaxLength(160)
  email!: string;
}
