// RFC 822 message with inline images (multipart/related), for `gog gmail send --raw-file`: gog has an
// --attach flag but no way to set a Content-ID, so images that must show inside the HTML need the full message.
import type { ValidatedMail } from "./mail.js";

export async function buildRawMessage(mail: ValidatedMail, from: string): Promise<Buffer> {
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  // `keepBcc` is supported by nodemailer but missing from its typings.
  const options = {
    from,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    html: mail.bodyHtml,
    text: mail.bodyText,
    keepBcc: true,
    attachments: mail.images.map((image) => ({
      filename: image.filename,
      content: image.content,
      contentType: image.contentType,
      cid: image.cid,
      contentDisposition: "inline" as const,
    })),
  };
  const info = (await transport.sendMail(options as never)) as unknown as { message: Buffer };
  return info.message;
}
