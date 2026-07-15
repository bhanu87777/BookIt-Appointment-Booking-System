import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import type { Channel, ChannelKey, RenderedMessage } from './types.js';

const OUTBOX = path.resolve('outbox');

const transporter = config.mail.host
  ? nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.port === 465,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true }); // dev fallback

const email: Channel = {
  key: 'email',
  async send(recipient: string, msg: RenderedMessage) {
    await transporter.sendMail({
      from: config.mail.from,
      to: recipient,
      subject: msg.subject,
      html: msg.html,
      attachments: msg.attachments,
    });
    if (!config.mail.host) {
      // dev mode: drop the rendered email into ./outbox so it can be inspected
      mkdirSync(OUTBOX, { recursive: true });
      const file = path.join(OUTBOX, `${Date.now()}-${msg.subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.html`);
      writeFileSync(file, msg.html);
      for (const a of msg.attachments ?? []) {
        writeFileSync(path.join(OUTBOX, `${Date.now()}-${a.filename}`), a.content);
      }
      console.log(`📧 [dev outbox] ${msg.subject} -> ${recipient}  (${file})`);
    }
  },
};

// SMS / WhatsApp adapters are future registry entries — the dispatcher is
// channel-agnostic, so adding one requires no changes elsewhere.
export const channels: Partial<Record<ChannelKey, Channel>> = { email };
