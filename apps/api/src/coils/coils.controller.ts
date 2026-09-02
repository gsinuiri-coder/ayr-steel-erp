import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  coilQuerySchema,
  createCoilScrapSchema,
  createCoilSplitSchema,
  reverseMovementSchema,
  Role,
  setCoilStatusSchema,
  updateCoilSchema,
  type CoilDto,
  type CoilQuery,
  type CoilSplitDto,
  type CreateCoilScrapInput,
  type CreateCoilSplitInput,
  type ReverseMovementInput,
  type SetCoilStatusInput,
  type UpdateCoilInput,
} from '@ayr/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CoilOperationsService } from './coil-operations.service';
import { CoilsService } from './coils.service';

/**
 * Bobinas (RF-10..RF-23). El alta entra por `purchases` (manual/XML) o por `imports`
 * (planilla), nunca por un POST directo a este módulo; lo que sí entra por acá son las
 * operaciones de Fase 2b sobre una bobina ya existente.
 *
 * Restringido a ADMINISTRADOR y SUPERVISOR_PLANTA (§3.4) porque el DTO lleva el costo
 * de compra por kilo. Anular una bobina y tocar su costo son solo de ADMINISTRADOR.
 */
@Controller('coils')
@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)
export class CoilsController {
  constructor(
    private readonly coils: CoilsService,
    private readonly operations: CoilOperationsService,
  ) {}

  @Get()
  findAll(@Query(new ZodValidationPipe(coilQuerySchema)) query: CoilQuery): Promise<CoilDto[]> {
    return this.coils.findAll(query);
  }

  /**
   * Anular una merma (RF-18). Va antes de `:id` porque `splits` y `scraps` son rutas
   * fijas y Nest resuelve por orden de declaración.
   */
  @Post('scraps/:movementId/cancel')
  cancelScrap(
    @CurrentUser() actor: RequestUser,
    @Param('movementId') movementId: string,
    @Body(new ZodValidationPipe(reverseMovementSchema)) body: ReverseMovementInput,
  ): Promise<CoilDto> {
    return this.operations.cancelScrap(actor, parseMovementId(movementId), body.reason);
  }

  /** Revertir un partido (RF-16). */
  @Post('splits/:splitId/revert')
  revertSplit(
    @CurrentUser() actor: RequestUser,
    @Param('splitId', ParseUUIDPipe) splitId: string,
    @Body(new ZodValidationPipe(reverseMovementSchema)) body: ReverseMovementInput,
  ): Promise<CoilSplitDto[]> {
    return this.operations.revertSplit(actor, splitId, body.reason);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CoilDto> {
    return this.coils.findOne(id);
  }

  /** Bobinas hijas de esta bobina (RF-15), para la vista de detalle. */
  @Get(':id/children')
  findChildren(@Param('id', ParseUUIDPipe) id: string): Promise<CoilDto[]> {
    return this.coils.findChildren(id);
  }

  @Get(':id/splits')
  findSplits(@Param('id', ParseUUIDPipe) id: string): Promise<CoilSplitDto[]> {
    return this.coils.findSplits(id);
  }

  /** Partir la bobina en hijas por ancho (RF-15). */
  @Post(':id/split')
  split(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createCoilSplitSchema)) body: CreateCoilSplitInput,
  ): Promise<CoilDto[]> {
    return this.operations.split(actor, id, body);
  }

  /** Registrar merma sobre la bobina (RF-17, D-040). */
  @Post(':id/scrap')
  scrap(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createCoilScrapSchema)) body: CreateCoilScrapInput,
  ): Promise<CoilDto> {
    return this.operations.registerScrap(actor, id, body);
  }

  /** Abrir o cerrar la bobina (RF-19). */
  @Post(':id/status')
  setStatus(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(setCoilStatusSchema)) body: SetCoilStatusInput,
  ): Promise<CoilDto> {
    return this.operations.setStatus(actor, id, body);
  }

  /**
   * Editar la bobina (RF-20). El servicio corta con 403 si un SUPERVISOR_PLANTA manda
   * campos de costo: la ruta la comparten los dos roles porque el ancho y las notas sí
   * son suyos (D-045).
   */
  @Patch(':id')
  update(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCoilSchema)) body: UpdateCoilInput,
  ): Promise<CoilDto> {
    return this.operations.update(actor, id, body);
  }

  /** Anular la bobina (RF-21). Solo si no tiene movimientos aparte del ingreso inicial. */
  @Post(':id/cancel')
  @Roles(Role.ADMINISTRADOR)
  cancel(
    @CurrentUser() actor: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reverseMovementSchema)) body: ReverseMovementInput,
  ): Promise<CoilDto> {
    return this.operations.cancel(actor, id, body.reason);
  }
}

/** Los ids de kardex son `BigInt` autoincremental, no UUID: `ParseUUIDPipe` no sirve. */
function parseMovementId(value: string): bigint {
  if (!/^\d{1,19}$/.test(value)) {
    throw new BadRequestException('Identificador de movimiento inválido');
  }
  return BigInt(value);
}
