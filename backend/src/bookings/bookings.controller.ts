import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { AdminGuard } from '../memberships/admin.guard';
import { JsonStore } from '../storage/json-store';
import { adminBookingView } from './booking.model';

import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /** Creates the booking and returns the SettleKing payment page to send the customer to. */
  @Post()
  create(@Body() dto: CreateBookingDto) {
    return this.bookings.create(dto);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.get(id);
  }

  /** Called by the return page: confirms the payment with SettleKing, server to server. */
  @Post(':id/sync')
  sync(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.sync(id);
  }
}

/** The studio admin's view of class bookings (X-Admin-Token). */
@Controller('admin/bookings')
@UseGuards(AdminGuard)
export class AdminBookingsController {
  constructor(private readonly store: JsonStore) {}

  /** The newest 50 bookings. */
  @Get()
  list() {
    return this.store.bookings().slice(0, 50).map(adminBookingView);
  }
}
