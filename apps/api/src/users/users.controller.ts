import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createUserSchema,
  Role,
  updateUserSchema,
  type CreateUserInput,
  type UpdateUserInput,
  type UserDto,
} from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsersService } from './users.service';

@Controller('users')
@Roles(Role.ADMINISTRADOR)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  findAll(): Promise<UserDto[]> {
    return this.users.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserDto> {
    return this.users.findOne(id);
  }

  @Post()
  create(
    @CurrentUser() actor: RequestUser,
    @Body(new ZodValidationPipe(createUserSchema)) body: CreateUserInput,
  ): Promise<UserDto> {
    return this.users.create(actor, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserInput,
  ): Promise<UserDto> {
    return this.users.update(actor, id, body);
  }

  @Delete(':id')
  deactivate(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UserDto> {
    return this.users.deactivate(actor, id);
  }
}
