import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  CONTRACT_PRICE_EXTRACTION_QUEUE,
} from './contract-extraction.constants';
import {
  ContractExtractionResult,
  ExtractionJobPayload,
} from './contract-extraction.types';

@Injectable()
export class ContractExtractionService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(CONTRACT_PRICE_EXTRACTION_QUEUE)
    private readonly extractionQueue: Queue<ExtractionJobPayload, ContractExtractionResult>,
  ) {}

  async queueContractExtraction(contractRef: string) {
    const contract = await this.resolveContract(contractRef);
    const jobId = this.buildJobId(contract.id);
    const existingJob = await this.extractionQueue.getJob(jobId);

    if (existingJob) {
      const state = await existingJob.getState();

      if (state === 'waiting' || state === 'active' || state === 'delayed') {
        return this.mapJobStatus(existingJob, contract);
      }

      if (state === 'completed' || state === 'failed') {
        await existingJob.remove();
      }
    }

    const job = await this.extractionQueue.add(
      'extract-selected-contract',
      { contractDbId: contract.id },
      {
        jobId,
        removeOnComplete: 20,
        removeOnFail: 20,
      },
    );

    return this.mapJobStatus(job, contract);
  }

  async getContractExtractionStatus(contractRef: string) {
    const contract = await this.resolveContract(contractRef);
    const jobId = this.buildJobId(contract.id);
    const job = await this.extractionQueue.getJob(jobId);

    if (!job) {
      return {
        contract: this.toContractSummary(contract),
        jobId,
        state: 'idle',
        result: null,
        failureReason: null,
      };
    }

    return this.mapJobStatus(job, contract);
  }

  private async mapJobStatus(job: Job, contract: any) {
    const state = await job.getState();

    return {
      contract: this.toContractSummary(contract),
      jobId: job.id,
      state,
      result: state === 'completed' ? (job.returnvalue ?? null) : null,
      failureReason: state === 'failed' ? (job.failedReason ?? null) : null,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn ?? null,
    };
  }

  private async resolveContract(contractRef: string) {
    const contract = await this.prisma.contract.findFirst({
      where: {
        OR: [{ id: contractRef }, { contractID: contractRef }],
      },
      include: {
        tender: {
          select: {
            id: true,
            tenderID: true,
          },
        },
      },
    });

    if (!contract) {
      throw new NotFoundException(`Contract not found: ${contractRef}`);
    }

    return contract;
  }

  private toContractSummary(contract: any) {
    return {
      id: contract.id,
      contractID: contract.contractID,
      tenderId: contract.tenderId,
      tenderPublicId: contract.tender?.tenderID ?? null,
    };
  }

  private buildJobId(contractDbId: string): string {
    return `contract-price-extraction-${contractDbId}`;
  }
}
