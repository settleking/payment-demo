import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, Length, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class StartPlanDto {
  @IsString()
  @Length(1, 40)
  planId!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name!: string;

  @Transform(trim)
  @IsEmail()
  @MaxLength(160)
  email!: string;

  /** hosted: send the customer to SettleKing's approval page; widget: approve from this page. */
  @IsIn(['hosted', 'widget'])
  approveVia!: 'hosted' | 'widget';
}
