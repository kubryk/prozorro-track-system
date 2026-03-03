import { Test, TestingModule } from '@nestjs/testing';
import { ProzorroService } from './prozorro.service';

describe('ProzorroService', () => {
  let service: ProzorroService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProzorroService],
    }).compile();

    service = module.get<ProzorroService>(ProzorroService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
