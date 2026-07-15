export type Template =
  | 'confirmation'
  | 'cancellation'
  | 'rescheduled'
  | 'receipt'
  | 'reminder_24h'
  | 'reminder_1h'
  | 'waitlist_slot_open'
  | 'series_summary'
  | 'series_cancelled';

export type ChannelKey = 'email' | 'sms' | 'whatsapp';

export interface RenderedMessage {
  subject: string;
  html: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}

export interface Channel {
  key: ChannelKey;
  send(recipient: string, msg: RenderedMessage): Promise<void>;
}

export interface NotificationRow {
  id: number;
  booking_id: number | null;
  waitlist_id: number | null;
  channel: ChannelKey;
  template: Template;
  recipient: string;
  payload: Record<string, any>;
  scheduled_for: string;
  next_attempt_at: string;
  attempts: number;
  last_error: string;
  status: 'pending' | 'sent' | 'failed' | 'void';
  sent_at: string | null;
}
