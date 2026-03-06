import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProzorroService } from './prozorro.service';

@Module({
  imports: [HttpModule],
  providers: [ProzorroService],
  exports: [ProzorroService],
})
export class ProzorroModule {}
