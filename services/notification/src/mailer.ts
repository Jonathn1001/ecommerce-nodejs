import nodemailer from "nodemailer";

export interface Mailer {
  send(msg: { to: string; subject: string; html: string }): Promise<void>;
}

export function createMailer(cfg: { host: string; port: number }): Mailer {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: false,
    // Bounded so a hung SMTP server fails fast -> retry -> DLQ rather than blocking the worker.
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000,
  });
  return {
    async send(msg) {
      await transport.sendMail({
        from: "no-reply@ecom.test",
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      });
    },
  };
}
