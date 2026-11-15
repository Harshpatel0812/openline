/** Recorded-style raw emails for tests (RFC 5322 text, CRLF line endings). */

export interface MailFixture {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string | null;
  inReplyTo?: string;
  references?: string;
  date?: string;
  headers?: Record<string, string>;
  text?: string;
  html?: string;
}

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

export function rawEmail(f: MailFixture = {}): Buffer {
  const headers: string[] = [
    `From: ${f.from ?? "Jane Buyer <jane@buyer.com>"}`,
    `To: ${f.to ?? "riley@acme.com"}`,
    `Subject: ${f.subject ?? "Re: Quick question"}`,
    `Date: ${f.date ?? "Wed, 18 Nov 2026 16:00:00 +0000"}`,
  ];
  if (f.messageId !== null)
    headers.push(
      `Message-ID: ${f.messageId ?? `<r${Math.random().toString(36).slice(2)}@buyer.com>`}`,
    );
  if (f.inReplyTo) headers.push(`In-Reply-To: ${f.inReplyTo}`);
  if (f.references) headers.push(`References: ${f.references}`);
  for (const [k, v] of Object.entries(f.headers ?? {})) headers.push(`${k}: ${v}`);
  headers.push("MIME-Version: 1.0");
  if (f.html && !f.text) {
    headers.push("Content-Type: text/html; charset=utf-8");
    return Buffer.from(crlf(`${headers.join("\n")}\n\n${f.html}\n`));
  }
  if (f.html && f.text) {
    headers.push('Content-Type: multipart/alternative; boundary="b1"');
    return Buffer.from(
      crlf(
        `${headers.join("\n")}\n\n--b1\nContent-Type: text/plain; charset=utf-8\n\n${f.text}\n--b1\nContent-Type: text/html; charset=utf-8\n\n${f.html}\n--b1--\n`,
      ),
    );
  }
  headers.push("Content-Type: text/plain; charset=utf-8");
  return Buffer.from(
    crlf(`${headers.join("\n")}\n\n${f.text ?? "Sounds good, let's talk Tuesday."}\n`),
  );
}

/** A standard multipart/report delivery status notification. */
export function bounceReport(opts: {
  recipient: string;
  status: string;
  originalMessageId?: string;
  from?: string;
  messageId?: string;
}): Buffer {
  const original = opts.originalMessageId
    ? `Message-ID: ${opts.originalMessageId}\nFrom: riley@acme.com\nTo: ${opts.recipient}\nSubject: Quick question\n`
    : `From: riley@acme.com\nTo: ${opts.recipient}\nSubject: Quick question\n`;
  return Buffer.from(
    crlf(`From: ${opts.from ?? "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"}
To: riley@acme.com
Subject: Delivery Status Notification (Failure)
Date: Wed, 18 Nov 2026 16:00:00 +0000
Message-ID: ${opts.messageId ?? `<dsn${Math.random().toString(36).slice(2)}@googlemail.com>`}
Auto-Submitted: auto-replied
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="r1"

--r1
Content-Type: text/plain; charset=utf-8

Address not found. Your message wasn't delivered to ${opts.recipient}.

--r1
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com

Final-Recipient: rfc822; ${opts.recipient}
Action: failed
Status: ${opts.status}
Diagnostic-Code: smtp; 550 5.1.1 user unknown

--r1
Content-Type: text/rfc822-headers

${original}
--r1--
`),
  );
}
