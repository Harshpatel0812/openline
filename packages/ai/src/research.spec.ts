import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { htmlToText, isSameSite, normalizeDomain, researchWebsite } from "./research";

/** A local https server with a throwaway self-signed certificate for "localhost". */
describe("researchWebsite (local https)", () => {
  let server: Server;
  let port = 0;
  let cert = "";
  const hits: string[] = [];
  let dir = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ol-research-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const key = readFileSync(join(dir, "key.pem"), "utf8");
    server = createServer({ key, cert }, (req, res) => {
      hits.push(req.url ?? "");
      const html = (body: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      };
      switch (req.url) {
        case "/":
          return html(`<html><head><title>Acme &amp; Co</title><style>.x{}</style></head><body>
            <script>alert("x")</script>
            <nav><a href="/about">About</a> <a href="/products/">Products</a>
            <a href="https://evil.example.com/about">Evil</a> <a href="http://localhost/services">Plain</a></nav>
            <h1>Rockets for everyone</h1><p>We build&nbsp;rockets.</p><!-- hidden comment --></body></html>`);
        case "/about":
          res.writeHead(301, { location: "/about-us" });
          return res.end();
        case "/about-us":
          return html("<p>Founded in 1999 in Toronto.</p>");
        case "/products/":
          return html("<ul><li>Model A</li><li>Model B</li></ul>");
        case "/big":
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end("a".repeat(50_000));
        default:
          res.writeHead(404);
          return res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const base = () => ({ allowPrivate: true, port, ca: cert });

  it("fetches the home page plus linked about and products pages, as text", async () => {
    const res = await researchWebsite("localhost", base());
    expect(res.failed).toBe(false);
    expect(res.pages.map((p) => p.url)).toEqual([
      `https://localhost:${port}/`,
      `https://localhost:${port}/about-us`,
      `https://localhost:${port}/products/`,
    ]);
    const home = res.pages[0]!;
    expect(home.title).toBe("Acme & Co");
    expect(home.text).toContain("Rockets for everyone");
    expect(home.text).toContain("We build rockets.");
    expect(home.text).not.toContain("alert");
    expect(home.text).not.toContain("hidden comment");
    expect(res.pages[1]!.text).toBe("Founded in 1999 in Toronto.");
    // Never followed the off-site or plain-http links.
    expect(hits).not.toContain("/services");
  });

  it("refuses private addresses outside development/test", async () => {
    const before = hits.length;
    const res = await researchWebsite("localhost", { ...base(), allowPrivate: false });
    expect(res).toEqual({ pages: [], failed: true });
    expect(hits.length).toBe(before);
  });

  it("still verifies the certificate against the host name (pinned address)", async () => {
    const res = await researchWebsite("localhost", { allowPrivate: true, port });
    expect(res.failed).toBe(true);
  });

  it("caps the download size", async () => {
    // Fetch /big via a tiny home page cap: the home page itself is truncated to maxBytes.
    const res = await researchWebsite("localhost", { ...base(), maxBytes: 40 });
    expect(res.pages[0]!.text.length).toBeLessThanOrEqual(40);
  });

  it("times out a slow server", async () => {
    const slow = createServer({ cert, key: readFileSync(join(dir, "key.pem")) }, () => {
      /* never answers */
    });
    await new Promise<void>((resolve) => slow.listen(0, resolve));
    const slowPort = (slow.address() as AddressInfo).port;
    const started = Date.now();
    const res = await researchWebsite("localhost", {
      allowPrivate: true,
      port: slowPort,
      ca: cert,
      timeoutMs: 200,
    });
    expect(res.failed).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    slow.closeAllConnections();
    await new Promise((resolve) => slow.close(resolve));
  });
});

describe("redirect and domain rules", () => {
  it("normalizes domains and refuses IPs, ports and credentials", () => {
    expect(normalizeDomain("https://www.Acme.com/about")).toBe("acme.com");
    expect(normalizeDomain("acme.co.uk.")).toBe("acme.co.uk");
    expect(normalizeDomain("10.0.0.1")).toBeNull();
    expect(normalizeDomain("acme.com:8080")).toBeNull();
    expect(normalizeDomain("user@acme.com")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
  });

  it("treats subdomains as the same site and look-alikes as different", () => {
    expect(isSameSite("www.acme.com", "acme.com")).toBe(true);
    expect(isSameSite("shop.acme.com", "acme.com")).toBe(true);
    expect(isSameSite("acme.com.evil.com", "acme.com")).toBe(false);
    expect(isSameSite("notacme.com", "acme.com")).toBe(false);
  });

  it("refuses a redirect to another site", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ol-research-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const hits: string[] = [];
    const server = createServer({ cert, key: readFileSync(join(dir, "key.pem")) }, (req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      const port = (server.address() as AddressInfo).port;
      res.writeHead(302, { location: `https://127.0.0.1:${port}/internal` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const res = await researchWebsite("localhost", { allowPrivate: true, port, ca: cert });
    expect(res.failed).toBe(true);
    expect(hits).toEqual([`localhost:${port}/`]);
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("htmlToText", () => {
  it("decodes entities and keeps block structure", () => {
    const out = htmlToText("<h1>A&#39;s &#x26; B</h1><p>one<br>two</p><a href='/x'>x</a>");
    expect(out.text).toBe("A's & B\none\ntwo\nx");
    expect(out.links).toEqual(["/x"]);
  });
});
