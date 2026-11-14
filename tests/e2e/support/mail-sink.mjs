// A local SMTP sink for the e2e journeys. It accepts every message (STARTTLS with the throwaway
// certificate playwright.config.ts makes, any login) and keeps them in memory; tests read them:
//   GET  http://localhost:2580/messages  -> [{ to: string[], raw: string }]
// It never relays anything, so nothing can reach a real inbox.
import fs from "node:fs";
import http from "node:http";
import { SMTPServer } from "smtp-server";

const SMTP_PORT = Number(process.env.MAIL_SINK_SMTP_PORT ?? 2525);
const HTTP_PORT = Number(process.env.MAIL_SINK_HTTP_PORT ?? 2580);
const messages = [];

const smtp = new SMTPServer({
  logger: false,
  key: fs.readFileSync(process.env.MAIL_SINK_TLS_KEY),
  cert: fs.readFileSync(process.env.MAIL_SINK_TLS_CERT),
  authOptional: true,
  onAuth(auth, _session, cb) {
    cb(null, { user: auth.username });
  },
  onData(stream, session, cb) {
    let raw = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (raw += chunk));
    stream.on("end", () => {
      messages.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
      cb();
    });
  },
});
smtp.listen(SMTP_PORT, "127.0.0.1");

http
  .createServer((req, res) => {
    if (req.url === "/messages") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(messages));
      return;
    }
    res.writeHead(req.url === "/health" ? 200 : 404).end();
  })
  .listen(HTTP_PORT, "127.0.0.1");
