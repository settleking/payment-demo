import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateBookingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  classId: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  studentName: string;

  @Transform(trim)
  @IsEmail()
  @MaxLength(160)
  email: string;

  /** "hosted" (default): SettleKing's payment page. "widget": pay inside this page. */
  @IsOptional()
  @IsIn(['hosted', 'widget'])
  payWith?: 'hosted' | 'widget';
}
