import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CONTRACT_PROMPT_TEMPLATE_DEFINITIONS,
  CONTRACT_PROMPT_TEMPLATE_DEFAULTS,
  ContractPromptTemplateKey,
} from './contract-prompt-settings.constants';

@Injectable()
export class ContractPromptSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getTemplates() {
    const rows = await this.prisma.promptTemplate.findMany({
      where: {
        key: {
          in: CONTRACT_PROMPT_TEMPLATE_DEFINITIONS.map((definition) => definition.key),
        },
      },
    });
    const contentByKey = new Map(rows.map((row) => [row.key, row.content]));

    return CONTRACT_PROMPT_TEMPLATE_DEFINITIONS.map((definition) => ({
      key: definition.key,
      label: definition.label,
      description: definition.description,
      group: definition.group,
      placeholders: definition.placeholders,
      defaultValue: definition.defaultValue,
      value: contentByKey.get(definition.key) ?? definition.defaultValue,
      isCustom: contentByKey.has(definition.key),
    }));
  }

  async updateTemplates(
    templates: Array<{
      key: string;
      content?: string | null;
      reset?: boolean;
    }>,
  ) {
    if (!templates.length) {
      return {
        templates: await this.getTemplates(),
      };
    }

    const validKeys = new Set(
      CONTRACT_PROMPT_TEMPLATE_DEFINITIONS.map((definition) => definition.key),
    );

    for (const template of templates) {
      if (!validKeys.has(template.key as ContractPromptTemplateKey)) {
        throw new BadRequestException(`Unknown prompt template key: ${template.key}`);
      }
    }

    await this.prisma.$transaction(
      templates.map((template) => {
        const key = template.key as ContractPromptTemplateKey;
        const nextContent =
          typeof template.content === 'string' ? template.content.trim() : '';

        if (template.reset || nextContent === CONTRACT_PROMPT_TEMPLATE_DEFAULTS[key]) {
          return this.prisma.promptTemplate.deleteMany({
            where: { key },
          });
        }

        if (!nextContent) {
          throw new BadRequestException(`Prompt template content cannot be empty for: ${key}`);
        }

        return this.prisma.promptTemplate.upsert({
          where: { key },
          update: { content: nextContent },
          create: { key, content: nextContent },
        });
      }),
    );

    return {
      templates: await this.getTemplates(),
    };
  }

  async getTemplateValues(
    keys: ContractPromptTemplateKey[],
  ): Promise<Record<ContractPromptTemplateKey, string>> {
    const rows = await this.prisma.promptTemplate.findMany({
      where: {
        key: { in: keys },
      },
    });
    const contentByKey = new Map(rows.map((row) => [row.key, row.content]));

    return keys.reduce(
      (accumulator, key) => {
        accumulator[key] = contentByKey.get(key) ?? CONTRACT_PROMPT_TEMPLATE_DEFAULTS[key];
        return accumulator;
      },
      {} as Record<ContractPromptTemplateKey, string>,
    );
  }

  renderTemplate(
    template: string,
    variables: Record<string, string | number | null | undefined>,
  ): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, variableName: string) => {
      const value = variables[variableName];
      return value === null || value === undefined ? '' : String(value);
    });
  }
}
