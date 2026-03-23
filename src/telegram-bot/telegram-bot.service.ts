import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { SearchService } from '../search/search.service';
import {
  TelegramBotAction,
  TelegramBotRole,
  TelegramSearchContext,
  TelegramSearchResultKind,
  TelegramBotSession,
  TelegramTenderStatusPreset,
  TelegramReplyMarkup,
} from './telegram-bot.types';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number };
    from?: { id: number; first_name?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; first_name?: string };
    message?: {
      message_id: number;
      chat?: { id: number };
    };
  };
};

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  private static readonly SEARCH_PAGE_SIZE = 5;
  private static readonly MAX_CONTRACTS_PER_TENDER = 3;
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly sessions = new Map<number, TelegramBotSession>();
  private polling = false;
  private destroyed = false;
  private updateOffset = 0;

  constructor(
    private readonly httpService: HttpService,
    private readonly searchService: SearchService,
  ) {}

  onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log(
        'Telegram bot is disabled. Set TELEGRAM_BOT_TOKEN to enable polling.',
      );
      return;
    }

    void this.registerCommands();
    void this.registerMenuButton();
    this.polling = true;
    void this.pollLoop();
    this.logger.log('Telegram bot polling started.');
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.polling = false;
  }

  private isEnabled(): boolean {
    return (
      Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
      process.env.APP_ROLE !== 'WORKER'
    );
  }

  private getToken(): string {
    return process.env.TELEGRAM_BOT_TOKEN || '';
  }

  private getBaseUrl(): string {
    return `https://api.telegram.org/bot${this.getToken()}`;
  }

  private async pollLoop(): Promise<void> {
    while (this.polling && !this.destroyed) {
      try {
        const updates = await this.getUpdates();

        for (const update of updates) {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown polling error';
        this.logger.warn(`Telegram polling failed: ${message}`);
        await this.sleep(3000);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const response = await firstValueFrom(
      this.httpService.get(`${this.getBaseUrl()}/getUpdates`, {
        params: {
          timeout: 25,
          offset: this.updateOffset,
          allowed_updates: JSON.stringify(['message', 'callback_query']),
        },
        timeout: 30000,
      }),
    );

    if (!response.data?.ok || !Array.isArray(response.data?.result)) {
      return [];
    }

    return response.data.result as TelegramUpdate[];
  }

  private async registerCommands(): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.getBaseUrl()}/setMyCommands`,
          {
            commands: [
              {
                command: 'start',
                description: 'Показати доступні команди',
              },
              {
                command: 'search',
                description: 'Список закупівель і договорів',
              },
              {
                command: 'analytics',
                description: 'Коротка аналітика по договорах',
              },
              {
                command: 'tender',
                description: 'Пошук за номером закупівлі',
              },
              {
                command: 'reset',
                description: 'Скинути поточний сценарій',
              },
            ],
          },
          {
            timeout: 10000,
          },
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown setMyCommands error';
      this.logger.warn(`Failed to register Telegram commands: ${message}`);
    }
  }

  private async registerMenuButton(): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.post(
          `${this.getBaseUrl()}/setChatMenuButton`,
          {
            menu_button: {
              type: 'commands',
            },
          },
          {
            timeout: 10000,
          },
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown setChatMenuButton error';
      this.logger.warn(`Failed to register Telegram menu button: ${message}`);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    if (update.message?.chat?.id) {
      await this.handleMessage(update.message.chat.id, update.message.text || '');
    }
  }

  private getSession(chatId: number): TelegramBotSession {
    const existing = this.sessions.get(chatId);

    if (existing) {
      return existing;
    }

    const session: TelegramBotSession = {
      chatId,
      step: 'idle',
      action: null,
      edrpou: null,
      minAmount: null,
      role: null,
      year: null,
      statusPreset: null,
      lastSearchContext: null,
    };

    this.sessions.set(chatId, session);
    return session;
  }

  private resetSession(
    chatId: number,
    action: TelegramBotAction | null = null,
  ): TelegramBotSession {
    const previous = this.sessions.get(chatId);
    const session: TelegramBotSession = {
      chatId,
      step: action ? 'awaiting_edrpou' : 'idle',
      action,
      edrpou: null,
      minAmount: null,
      role: null,
      year: null,
      statusPreset: null,
      lastSearchContext: previous?.lastSearchContext || null,
    };

    this.sessions.set(chatId, session);
    return session;
  }

  private async handleMessage(chatId: number, rawText: string): Promise<void> {
    const text = rawText.trim();
    const session = this.getSession(chatId);

    if (!text) {
      return;
    }

    if (text === '/start') {
      this.resetSession(chatId);
      await this.sendMessage(
        chatId,
        [
          'Доступні команди:',
          '/search — список знайдених закупівель і договорів',
          '/analytics — коротка аналітика по знайдених договорах',
          '/tender — профіль закупівлі, договори і документи',
          '/reset — скинути поточний сценарій',
        ].join('\n'),
      );
      return;
    }

    if (text === '/reset') {
      this.resetSession(chatId);
      await this.sendMessage(
        chatId,
        'Сценарій скинуто. Використайте /search, /analytics або /tender.',
      );
      return;
    }

    if (text === '/tender') {
      const nextSession = this.resetSession(chatId, 'tender_lookup');
      nextSession.step = 'awaiting_tender_number';
      await this.sendMessage(
        chatId,
        'Введіть номер закупівлі, наприклад: UA-2025-03-20-001749-a',
      );
      return;
    }

    if (text === '/search' || text === '/analytics') {
      const action: TelegramBotAction =
        text === '/search' ? 'search' : 'analytics';
      this.resetSession(chatId, action);
      await this.sendMessage(
        chatId,
        action === 'search'
          ? 'Введіть ЄДРПОУ (8 або 10 цифр), щоб отримати список закупівель і договорів.'
          : 'Введіть ЄДРПОУ (8 або 10 цифр), щоб отримати аналітику по договорах.',
      );
      return;
    }

    if (session.step === 'awaiting_tender_number') {
      await this.runTenderLookup(chatId, text);
      this.resetSession(chatId);
      return;
    }

    if (session.step === 'awaiting_min_amount') {
      const normalizedAmount = text.replace(/\s+/g, '').replace(',', '.');
      const minAmount = Number.parseFloat(normalizedAmount);

      if (!Number.isFinite(minAmount) || minAmount < 0) {
        await this.sendMessage(
          chatId,
          'Сума має бути числом від 0 і більше. Наприклад: 100000',
        );
        return;
      }

      session.minAmount = minAmount;
      session.step = 'awaiting_role';

      await this.sendMessage(chatId, 'Оберіть роль:', {
        inline_keyboard: [
          [
            { text: 'Замовник', callback_data: 'role:customer' },
            { text: 'Підрядник', callback_data: 'role:supplier' },
          ],
          [{ text: 'Обидві', callback_data: 'role:both' }],
        ],
      });
      return;
    }

    if (session.step !== 'awaiting_edrpou') {
      await this.sendMessage(
        chatId,
        'Оберіть команду: /search, /analytics або /tender',
      );
      return;
    }

    const edrpou = text.replace(/\s+/g, '');
    if (!/^\d{8}(\d{2})?$/.test(edrpou)) {
      await this.sendMessage(
        chatId,
        'ЄДРПОУ має містити 8 або 10 цифр. Спробуйте ще раз.',
      );
      return;
    }

    session.edrpou = edrpou;
    session.step = 'awaiting_min_amount';
    await this.sendMessage(
      chatId,
      'Введіть мінімальну суму, від якої шукати. Наприклад: 100000',
    );
  }

  private async handleCallbackQuery(callbackQuery: TelegramUpdate['callback_query']) {
    const chatId = callbackQuery?.message?.chat?.id;
    const callbackId = callbackQuery?.id;
    const messageId = callbackQuery?.message?.message_id;
    const data = callbackQuery?.data || '';

    if (!chatId || !callbackId) {
      return;
    }

    const session = this.getSession(chatId);

    if (data.startsWith('role:')) {
      const role = data.slice('role:'.length) as TelegramBotRole;
      session.role = role;
      session.step = 'awaiting_status';

      await this.answerCallbackQuery(callbackId);
      await this.sendMessage(chatId, 'Оберіть статус:', {
        inline_keyboard: [
          [
            { text: 'Всі', callback_data: 'status:all' },
            { text: 'Активні', callback_data: 'status:active' },
          ],
          [
            { text: 'Завершені', callback_data: 'status:complete' },
            { text: 'Скасовані', callback_data: 'status:cancelled' },
          ],
          [
            { text: 'Неуспішні', callback_data: 'status:unsuccessful' },
          ],
        ],
      });
      return;
    }

    if (data.startsWith('status:')) {
      const preset = data.slice('status:'.length) as TelegramTenderStatusPreset;

      if (
        preset !== 'all' &&
        preset !== 'active' &&
        preset !== 'complete' &&
        preset !== 'cancelled' &&
        preset !== 'unsuccessful'
      ) {
        await this.answerCallbackQuery(callbackId, 'Некоректний статус.');
        return;
      }

      session.statusPreset = preset;
      session.step = 'awaiting_year';

      await this.answerCallbackQuery(callbackId);
      await this.sendMessage(chatId, 'Оберіть рік:', {
        inline_keyboard: [
          [
            { text: '2025', callback_data: 'year:2025' },
            { text: '2026', callback_data: 'year:2026' },
          ],
        ],
      });
      return;
    }

    if (data.startsWith('year:')) {
      const rawYear = Number.parseInt(data.slice('year:'.length), 10);

      if (rawYear !== 2025 && rawYear !== 2026) {
        await this.answerCallbackQuery(callbackId, 'Некоректний рік.');
        return;
      }

      session.year = rawYear;
      await this.answerCallbackQuery(callbackId, 'Шукаю...');
      await this.runSearchAndReply(chatId, session);
      session.step = 'idle';
      if (session.action === 'analytics') {
        session.action = null;
      }
      return;
    }

    if (data.startsWith('page:')) {
      const [, kind, rawPage] = data.split(':');
      const page = Number.parseInt(rawPage || '', 10);

      if (
        kind !== 'search' ||
        !Number.isFinite(page) ||
        page < 0
      ) {
        await this.answerCallbackQuery(callbackId, 'Некоректна сторінка.');
        return;
      }

      await this.answerCallbackQuery(callbackId, 'Відкриваю...');
      await this.sendSearchPage(
        chatId,
        session,
        kind as TelegramSearchResultKind,
        page,
        messageId,
      );
      return;
    }

    if (data.startsWith('analyze:')) {
      await this.answerCallbackQuery(
        callbackId,
        'Кнопка аналізу буде підключена пізніше.',
      );
      return;
    }

    await this.answerCallbackQuery(callbackId);
  }

  private async runSearchAndReply(
    chatId: number,
    session: TelegramBotSession,
  ): Promise<void> {
    if (
      !session.edrpou ||
      session.minAmount === null ||
      !session.role ||
      !session.statusPreset ||
      !session.year ||
      !session.action
    ) {
      await this.sendMessage(
        chatId,
        'Не вистачає даних для запиту. Використайте /search, /analytics або /tender і спробуйте ще раз.',
      );
      return;
    }

    const roleFilter =
      session.role === 'both'
        ? (['customer', 'supplier'] as const)
        : session.role;
    const dateFrom = `${session.year}-01-01`;
    const dateTo = `${session.year}-12-31`;
    const tenderStatus = this.getTenderStatusFilter(session.statusPreset);

    const tenders = await this.searchService.searchTenders({
      edrpou: session.edrpou,
      role: roleFilter as any,
      dateFrom,
      dateTo,
      dateType: 'dateCreated',
      sort: 'dateCreatedDesc',
      priceFrom: session.minAmount,
      status: tenderStatus,
      take: TelegramBotService.SEARCH_PAGE_SIZE,
      skip: 0,
    });

    const contractTotal =
      typeof tenders.relatedContractTotal === 'number'
        ? tenders.relatedContractTotal
        : tenders.data.reduce((sum: number, tender: any) => {
            return sum + (Array.isArray(tender?.contracts) ? tender.contracts.length : 0);
          }, 0);

    const summary = [
      `ЄДРПОУ: ${session.edrpou}`,
      `Команда: ${session.action === 'search' ? 'пошук списку' : 'аналітика'}`,
      `Сума від: ${this.formatAmount(session.minAmount)}`,
      `Роль: ${this.getRoleLabel(session.role)}`,
      `Статус: ${this.getStatusPresetLabel(session.statusPreset)}`,
      `Рік: ${session.year}`,
      `Знайдено тендерів: ${tenders.total}`,
      `Знайдено договорів: ${contractTotal}`,
    ].join('\n');

    if (session.action === 'search') {
      session.lastSearchContext = {
        edrpou: session.edrpou,
        minAmount: session.minAmount,
        role: session.role,
        year: session.year,
        statusPreset: session.statusPreset,
      };
    }

    await this.sendMessage(chatId, summary);
    if (session.action === 'analytics') {
      const analytics = await this.searchService.getPortfolioAnalytics({
        edrpou: session.edrpou,
        role: roleFilter as any,
        year: session.year,
        priceFrom: session.minAmount,
        tenderStatus,
      });
      await this.sendMessage(chatId, this.formatAnalyticsMessage(analytics));

      if (tenders.total === 0 && contractTotal === 0) {
        await this.sendMessage(chatId, 'Нічого не знайдено.');
      }
      return;
    }

    if (tenders.total > 0) {
      await this.sendMessage(
        chatId,
        this.formatGroupedSearchMessage(
          tenders.data,
          tenders.total,
          0,
          session.edrpou,
          session.role,
        ),
        this.buildSearchPaginationMarkup('search', 0, tenders.total),
        'HTML',
      );
    }

    if (tenders.total === 0 && contractTotal === 0) {
      await this.sendMessage(chatId, 'Нічого не знайдено.');
    }
  }

  private async runTenderLookup(chatId: number, tenderNumber: string): Promise<void> {
    const normalizedTenderNumber = tenderNumber
      .trim()
      .replace(/\s+/g, '')
      .replace(/[‐‑–—−]/g, '-')
      .toUpperCase();

    if (!/^UA-\d{4}-\d{2}-\d{2}-\d{6}-[A-Z]$/i.test(normalizedTenderNumber)) {
      await this.sendMessage(
        chatId,
        'Невірний номер закупівлі. Приклад: UA-2025-03-20-001749-a',
      );
      return;
    }

    const result = await this.searchService.getTenderProfileByTenderNumber(
      normalizedTenderNumber,
    );

    if (!result) {
      await this.sendMessage(chatId, 'Закупівлю не знайдено.');
      return;
    }

    await this.sendMessage(
      chatId,
      this.formatTenderLookupMessage(result),
      {
        inline_keyboard: [
          [
            {
              text: 'Детальний аналіз закупівлі',
              callback_data: `analyze:${normalizedTenderNumber}`,
            },
          ],
        ],
      },
      'HTML',
    );
  }

  private async sendSearchPage(
    chatId: number,
    session: TelegramBotSession,
    kind: TelegramSearchResultKind,
    page: number,
    messageId?: number,
  ): Promise<void> {
    const searchContext = this.getSearchContext(session);

    if (!searchContext) {
      await this.sendMessage(
        chatId,
        'Немає активного пошуку. Використайте /search.',
      );
      return;
    }

    const roleFilter =
      searchContext.role === 'both'
        ? (['customer', 'supplier'] as const)
        : searchContext.role;
    const dateFrom = `${searchContext.year}-01-01`;
    const dateTo = `${searchContext.year}-12-31`;
    const skip = page * TelegramBotService.SEARCH_PAGE_SIZE;
    const tenderStatus = this.getTenderStatusFilter(searchContext.statusPreset);

    const tenders = await this.searchService.searchTenders({
      edrpou: searchContext.edrpou,
      role: roleFilter as any,
      dateFrom,
      dateTo,
      dateType: 'dateCreated',
      sort: 'dateCreatedDesc',
      priceFrom: searchContext.minAmount,
      status: tenderStatus,
      take: TelegramBotService.SEARCH_PAGE_SIZE,
      skip,
    });

    if (tenders.total === 0) {
      await this.sendMessage(chatId, 'Закупівель не знайдено.');
      return;
    }

    const text = this.formatGroupedSearchMessage(
      tenders.data,
      tenders.total,
      page,
      searchContext.edrpou,
      searchContext.role,
    );
    const replyMarkup = this.buildSearchPaginationMarkup(
      'search',
      page,
      tenders.total,
    );

    if (typeof messageId === 'number') {
      await this.editMessage(chatId, messageId, text, replyMarkup, 'HTML');
      return;
    }

    await this.sendMessage(chatId, text, replyMarkup, 'HTML');
  }

  private getSearchContext(
    session: TelegramBotSession,
  ): TelegramSearchContext | null {
    if (
      session.edrpou &&
      session.minAmount !== null &&
      session.role &&
      session.statusPreset &&
      session.year &&
      session.action === 'search'
    ) {
      return {
        edrpou: session.edrpou,
        minAmount: session.minAmount,
        role: session.role,
        year: session.year,
        statusPreset: session.statusPreset,
      };
    }

    return session.lastSearchContext;
  }

  private formatGroupedSearchMessage(
    items: any[],
    total: number,
    page: number,
    edrpou: string,
    role: TelegramBotRole,
  ): string {
    const startIndex = page * TelegramBotService.SEARCH_PAGE_SIZE;
    const lines = items.map((item: any, index: number) => {
      const tenderId = item?.tenderID || item?.id || '—';
      const title = this.escapeHtml(this.truncate(item?.title || 'Без назви', 120));
      const amount =
        typeof item?.amount === 'number'
          ? item.amount.toLocaleString('uk-UA', { maximumFractionDigits: 2 })
          : '—';
      const status = this.escapeHtml(item?.status || '—');
      const tenderLink =
        tenderId !== '—' ? `https://prozorro.gov.ua/tender/${tenderId}` : '';
      const safeTenderId = this.escapeHtml(tenderId);
      const relevantContracts = this.getRelevantContracts(item?.contracts, edrpou, role);
      const visibleContracts = relevantContracts.slice(
        0,
        TelegramBotService.MAX_CONTRACTS_PER_TENDER,
      );
      const hiddenContractsCount = Math.max(
        0,
        relevantContracts.length - visibleContracts.length,
      );
      const contractLines =
        relevantContracts.length > 0
          ? visibleContracts
              .map((contract: any, contractIndex: number) => {
                const contractId = contract?.contractID || contract?.id || '—';
                const contractStatus = this.escapeHtml(contract?.status || '—');
                const contractAmount =
                  typeof contract?.amount === 'number'
                    ? contract.amount.toLocaleString('uk-UA', {
                        maximumFractionDigits: 2,
                      })
                    : '—';
                const contractLink =
                  contractId !== '—'
                    ? `https://prozorro.gov.ua/contract/${contractId}`
                    : '';
                const safeContractId = this.escapeHtml(contractId);

                return [
                  `  ${contractIndex + 1}. Договір ${safeContractId}`,
                  `  Статус: ${contractStatus}`,
                  `  Сума: ${contractAmount}`,
                  contractLink
                    ? `  Посилання: <a href="${contractLink}">Відкрити договір</a>`
                    : '',
                ]
                  .filter(Boolean)
                  .join('\n');
              })
              .concat(
                hiddenContractsCount > 0
                  ? [`  … ще ${hiddenContractsCount} договорів`]
                  : [],
              )
              .join('\n\n')
          : '  Немає договорів для цього фільтра.';

      return [
        `${startIndex + index + 1}. ${title}`,
        `ID закупівлі: ${safeTenderId}`,
        `Статус: ${status}`,
        `Сума: ${amount}`,
        tenderLink ? `Посилання: <a href="${tenderLink}">Відкрити закупівлю</a>` : '',
        'Договори:',
        contractLines,
      ]
        .filter(Boolean)
        .join('\n');
    });

    const pageCount = Math.max(
      1,
      Math.ceil(total / TelegramBotService.SEARCH_PAGE_SIZE),
    );

    return `Закупівлі та договори (сторінка ${page + 1}/${pageCount}, ${Math.min(items.length, total - startIndex)} з ${total}):\n\n${lines.join('\n\n')}`;
  }

  private formatAnalyticsMessage(analytics: {
    tenderTotal: number;
    contractTotal: number;
    totalAmount: number;
    averageAmount: number | null;
    currencies: string[];
    topCounterparties: Array<{ name: string; contracts: number; amount: number }>;
  }): string {
    const currencySuffix =
      analytics.currencies.length === 1 ? ` ${analytics.currencies[0]}` : '';
    const totalAmount = `${this.formatAmount(analytics.totalAmount)}${currencySuffix}`;
    const averageAmount =
      analytics.averageAmount !== null
        ? `${this.formatAmount(analytics.averageAmount)}${currencySuffix}`
        : '—';

    const topCounterparties =
      analytics.topCounterparties.length > 0
        ? analytics.topCounterparties
            .map((item, index) => {
              return `${index + 1}. ${item.name} — ${item.contracts} дог., ${this.formatAmount(item.amount)}${currencySuffix}`;
            })
            .join('\n')
        : '—';

    return [
      'Аналітика по масиву договорів',
      '',
      `• Загальна сума договорів: ${totalAmount}`,
      `• Середня сума договору: ${averageAmount}`,
      '',
      '• Топ контрагентів:',
      topCounterparties,
    ].join('\n');
  }

  private formatTenderLookupMessage(result: {
    tender: any;
    tenderDetails: any;
    contracts: Array<any>;
  }): string {
    const tender = result.tender;
    const tenderDetails = result.tenderDetails;
    const tenderNumber = this.escapeHtml(tender.tenderID || tender.id || '—');
    const title = this.escapeHtml(tender.title || tenderDetails?.title || 'Без назви');
    const status = this.escapeHtml(tender.status || tenderDetails?.status || '—');
    const amount =
      typeof tender.amount === 'number' ? this.formatAmount(tender.amount) : '—';
    const customer = this.escapeHtml(
      tender.customerName ||
        tenderDetails?.procuringEntity?.name ||
        tenderDetails?.procuringEntity?.identifier?.legalName ||
        '—',
    );
    const tenderLink =
      tender.tenderID ? `https://prozorro.gov.ua/tender/${tender.tenderID}` : '';
    const tenderDocuments = Array.isArray(tenderDetails?.documents)
      ? tenderDetails.documents
      : [];

    const tenderDocumentLines =
      tenderDocuments.length > 0
        ? tenderDocuments
            .slice(0, 8)
            .map((document: any) => {
              const title = this.escapeHtml(
                document?.title || document?.documentType || 'Документ',
              );
              return `• ${title}`;
            })
            .join('\n')
        : '• Документів закупівлі не знайдено';

    const contractLines =
      result.contracts.length > 0
        ? result.contracts
            .map((contract, index) => {
              const contractId = this.escapeHtml(contract.contractID || contract.id || '—');
              const contractStatus = this.escapeHtml(
                contract.status || contract.details?.status || '—',
              );
              const contractAmount =
                typeof contract.amount === 'number'
                  ? this.formatAmount(contract.amount)
                  : '—';
              const contractLink =
                contract.contractID
                  ? `https://prozorro.gov.ua/contract/${contract.contractID}`
                  : '';
              const contractDocuments = Array.isArray(contract.details?.documents)
                ? contract.details.documents
                : [];
              const contractDocumentLines =
                contractDocuments.length > 0
                  ? contractDocuments
                      .slice(0, 5)
                      .map((document: any) => {
                        const title = this.escapeHtml(
                          document?.title || document?.documentType || 'Документ',
                        );
                        return `    • ${title}`;
                      })
                      .join('\n')
                  : '    • Документів не знайдено';

              return [
                `${index + 1}. Договір ${contractId}`,
                `   Статус: ${contractStatus}`,
                `   Сума: ${contractAmount}`,
                contractLink
                  ? `   Посилання: <a href="${contractLink}">Відкрити договір</a>`
                  : '',
                '   Документи:',
                contractDocumentLines,
              ]
                .filter(Boolean)
                .join('\n');
            })
            .join('\n\n')
        : 'Договорів не знайдено.';

    return [
      'Профіль закупівлі',
      '',
      `Назва: ${title}`,
      `Номер: ${tenderNumber}`,
      `Статус: ${status}`,
      `Замовник: ${customer}`,
      `Сума: ${amount}`,
      tenderLink
        ? `Посилання: <a href="${tenderLink}">Відкрити закупівлю</a>`
        : '',
      '',
      'Документи закупівлі:',
      tenderDocumentLines,
      '',
      'Договори та документи:',
      contractLines,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private getRoleLabel(role: TelegramBotRole): string {
    if (role === 'customer') {
      return 'замовник';
    }

    if (role === 'supplier') {
      return 'підрядник';
    }

    return 'обидві';
  }

  private getTenderStatusFilter(
    preset: TelegramTenderStatusPreset,
  ): string | string[] | undefined {
    switch (preset) {
      case 'active':
        return [
          'active.enquiries',
          'active.tendering',
          'active.auction',
          'active.qualification',
          'active.awarded',
          'active.pre-qualification',
          'active.pre-qualification.stand-still',
        ];
      case 'complete':
        return 'complete';
      case 'cancelled':
        return 'cancelled';
      case 'unsuccessful':
        return 'unsuccessful';
      case 'all':
      default:
        return undefined;
    }
  }

  private getStatusPresetLabel(preset: TelegramTenderStatusPreset): string {
    switch (preset) {
      case 'active':
        return 'активні';
      case 'complete':
        return 'завершені';
      case 'cancelled':
        return 'скасовані';
      case 'unsuccessful':
        return 'неуспішні';
      case 'all':
      default:
        return 'всі';
    }
  }

  private formatAmount(value: number): string {
    return value.toLocaleString('uk-UA', {
      maximumFractionDigits: 2,
    });
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private getRelevantContracts(
    contracts: any[] | undefined,
    edrpou: string,
    role: TelegramBotRole,
  ): any[] {
    if (!Array.isArray(contracts) || contracts.length === 0) {
      return [];
    }

    if (role === 'customer') {
      return contracts;
    }

    return contracts.filter((contract) => {
      if (role === 'supplier') {
        return contract?.supplierEdrpou === edrpou;
      }

      return true;
    });
  }

  private buildSearchPaginationMarkup(
    kind: TelegramSearchResultKind,
    page: number,
    total: number,
  ): TelegramReplyMarkup | undefined {
    const pageCount = Math.ceil(total / TelegramBotService.SEARCH_PAGE_SIZE);

    if (pageCount <= 1) {
      return undefined;
    }

    const buttons = [];

    if (page > 0) {
      buttons.push({
        text: '← Назад',
        callback_data: `page:${kind}:${page - 1}`,
      });
    }

    if (page + 1 < pageCount) {
      buttons.push({
        text: 'Далі →',
        callback_data: `page:${kind}:${page + 1}`,
      });
    }

    if (buttons.length === 0) {
      return undefined;
    }

    return {
      inline_keyboard: [buttons],
    };
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength - 1)}…`;
  }

  private async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
    parseMode?: 'HTML',
  ): Promise<void> {
    const chunks = this.chunkMessage(text, 3800);

    for (let index = 0; index < chunks.length; index += 1) {
      await firstValueFrom(
        this.httpService.post(
          `${this.getBaseUrl()}/sendMessage`,
          {
            chat_id: chatId,
            text: chunks[index],
            reply_markup: index === chunks.length - 1 ? replyMarkup : undefined,
            disable_web_page_preview: true,
            parse_mode: parseMode,
          },
          {
            timeout: 20000,
          },
        ),
      );
    }
  }

  private async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: TelegramReplyMarkup,
    parseMode?: 'HTML',
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${this.getBaseUrl()}/editMessageText`,
        {
          chat_id: chatId,
          message_id: messageId,
          text,
          reply_markup: replyMarkup,
          disable_web_page_preview: true,
          parse_mode: parseMode,
        },
        {
          timeout: 20000,
        },
      ),
    );
  }

  private async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.post(
        `${this.getBaseUrl()}/answerCallbackQuery`,
        {
          callback_query_id: callbackQueryId,
          text,
        },
        {
          timeout: 10000,
        },
      ),
    );
  }

  private chunkMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLength) {
      const slice = remaining.slice(0, maxLength);
      const breakIndex = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
      const safeIndex = breakIndex > 500 ? breakIndex : maxLength;
      chunks.push(remaining.slice(0, safeIndex).trim());
      remaining = remaining.slice(safeIndex).trim();
    }

    if (remaining) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
