import { EdrpouRole } from '../search/search.service';

export type TelegramBotRole = EdrpouRole | 'both';
export type TelegramBotAction = 'search' | 'analytics' | 'tender_lookup';
export type TelegramTenderStatusPreset =
  | 'all'
  | 'active'
  | 'complete'
  | 'cancelled'
  | 'unsuccessful';

export interface TelegramSearchContext {
  edrpou: string;
  minAmount: number;
  role: TelegramBotRole;
  year: 2025 | 2026;
  statusPreset: TelegramTenderStatusPreset;
}

export interface TelegramBotSession {
  chatId: number;
  step:
    | 'idle'
    | 'awaiting_edrpou'
    | 'awaiting_min_amount'
    | 'awaiting_role'
    | 'awaiting_status'
    | 'awaiting_year'
    | 'awaiting_tender_number';
  action: TelegramBotAction | null;
  edrpou: string | null;
  minAmount: number | null;
  role: TelegramBotRole | null;
  year: 2025 | 2026 | null;
  statusPreset: TelegramTenderStatusPreset | null;
  lastSearchContext: TelegramSearchContext | null;
}

export type TelegramSearchResultKind = 'search';

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}
