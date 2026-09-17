import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from './user.entity';
import { UsersService } from './users.service';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';

/**
 * Admin-only user management (Create Account has no role picker - every
 * self-registered account starts as `architect`; this is the only way to
 * reach `admin`/`viewer` without touching the database directly).
 */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  async findAll() {
    const users = await this.usersService.findAll();
    return users.map(({ passwordHash, ...rest }) => rest);
  }

  @Patch(':id/role')
  async updateRole(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserRoleDto) {
    const user = await this.usersService.updateRole(id, dto.role);
    const { passwordHash, ...rest } = user;
    return rest;
  }
}
