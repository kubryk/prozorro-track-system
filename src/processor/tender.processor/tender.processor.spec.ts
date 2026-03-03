import { Test, TestingModule } from '@nestjs/testing';
import { TenderProcessor } from './tender.processor';

describe('TenderProcessor', () => {
  let provider: TenderProcessor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TenderProcessor],
    }).compile();

    provider = module.get<TenderProcessor>(TenderProcessor);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
