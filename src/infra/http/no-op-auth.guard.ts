import { CanActivate, Injectable } from '@nestjs/common';

@Injectable()
export class NoOpAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}