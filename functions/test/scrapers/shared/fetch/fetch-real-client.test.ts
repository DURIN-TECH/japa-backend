// ============================================
// Fetch service over the REAL HTTP client (issue #33) — localhost only
// ============================================
//
// The other fetch tests stub the HTTP client. This file drives
// `fetchAndClean()` through the production axios client against an HTTP
// server started on 127.0.0.1 for the test, so the streamed-body code runs
// for real: response streams, gzip decoding, redirects, the size caps applied
// while bytes arrive, the stall timers and the 429 backoff. Nothing leaves
// the machine.
//
// It guards two things:
//  - HTML is read exactly as before bodies were streamed (same clean text,
//    same content hash) for plain, byte-order-marked, gzipped and redirected
//    responses;
//  - PDFs arrive intact over a real socket and the caps cut real downloads.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import {
  MAX_HTML_BYTES,
  VisaCatalogFetchService,
} from "../../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { isPdfFetchError } from "../../../../src/scrapers/shared/fetch/pdf-text";
import { isHostBackoffError } from "../../../../src/scrapers/shared/etiquette/visa-crawl-host-state";
import { buildPdf } from "../../../helpers/pdf-fixture";

// ----- What the local server serves -----

// A page with non-ASCII characters (multi-byte in UTF-8), chrome to strip and
// enough text to clear the "too little content" floor.
const FILLER = "Applicants must show they have enough money — £1,270 for 28 days. ".repeat(10);
const HTML = `<html><body><nav>menu</nav><main><h1>Visitor</h1><p>${FILLER}</p></main></body></html>`;

// A three-page PDF with distinct text per page.
const PDF_PAGES = [1, 2, 3].map(
  (n) => `Guidance page ${n}\nThe decision maker must consider all of the evidence provided and record the reasons.`
);
const PDF_BYTES = buildPdf(PDF_PAGES, { compress: true });

/** sha256 hex, independently of the service. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Route table for the local server, keyed by path. */
const routes: Record<string, (res: http.ServerResponse) => void> = {
  "/plain": (res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(HTML);
  },
  // UTF-8 byte-order mark in front of the document.
  "/bom": (res) => {
    res.setHeader("content-type", "text/html");
    res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(HTML)]));
  },
  "/gzip": (res) => {
    res.setHeader("content-type", "text/html");
    res.setHeader("content-encoding", "gzip");
    res.end(gzipSync(HTML));
  },
  "/redirect": (res) => {
    res.statusCode = 302;
    res.setHeader("location", "/plain");
    res.end();
  },
  // ~9 MB of HTML with no Content-Length (chunked): over the 5 MB HTML cap.
  "/big-html": (res) => {
    res.setHeader("content-type", "text/html");
    const chunk = Buffer.alloc(1 << 20, 0x61);
    let sent = 0;
    const write = () => {
      if (sent++ > 8 || res.destroyed) return void res.end();
      res.write(chunk, write);
    };
    write();
  },
  // 50 MB of HTML that is only ~50 KB on the wire: the cap must count the
  // DECOMPRESSED bytes.
  "/gzip-bomb": (res) => {
    res.setHeader("content-type", "text/html");
    res.setHeader("content-encoding", "gzip");
    res.end(gzipSync(Buffer.alloc(50 << 20, 0x61)));
  },
  // Sends the first bytes, then goes silent without closing.
  "/stall": (res) => {
    res.setHeader("content-type", "text/html");
    res.write("<html>");
  },
  "/doc.pdf": (res) => {
    res.setHeader("content-type", "application/pdf");
    res.end(PDF_BYTES);
  },
  // A PDF behind a generic content type, recognised by its `.pdf` path.
  "/files/generic.pdf": (res) => {
    res.setHeader("content-type", "application/octet-stream");
    res.end(PDF_BYTES);
  },
  // A web-page URL that redirects to the PDF.
  "/latest": (res) => {
    res.statusCode = 302;
    res.setHeader("location", "/doc.pdf");
    res.end();
  },
  // An endless "PDF" with no Content-Length.
  "/endless.pdf": (res) => {
    res.setHeader("content-type", "application/pdf");
    const chunk = Buffer.alloc(64 * 1024, 0x25);
    const write = () => {
      if (res.destroyed) return;
      res.write(chunk, write);
    };
    write();
  },
  // An HTML error page labelled as a PDF.
  "/missing.pdf": (res) => {
    res.statusCode = 404;
    res.setHeader("content-type", "application/pdf");
    res.end("<html>not here</html>");
  },
  "/throttled.pdf": (res) => {
    res.statusCode = 429;
    res.setHeader("retry-after", "30");
    res.setHeader("content-type", "application/pdf");
    res.end("slow down");
  },
};

describe("fetchAndClean over the real HTTP client (local server)", () => {
  let server: http.Server;
  let base = "";
  // User-Agent header of every request the server received, by path.
  const userAgents = new Map<string, string>();

  before(async () => {
    server = http.createServer((req, res) => {
      const path = req.url ?? "/";
      userAgents.set(path, String(req.headers["user-agent"] ?? ""));
      const route = routes[path];
      if (route) return route(res);
      // Anything else (robots.txt included) is a plain 404.
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    // Drop any connection a test left open (stalled / endless responses).
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Production client and limits; only the politeness gap and timers shortened. */
  const service = (overrides: ConstructorParameters<typeof VisaCatalogFetchService>[0] = {}) =>
    new VisaCatalogFetchService({
      minIntervalMs: 0,
      // Issue #159: the default client refuses loopback and non-standard
      // ports; this test's stub is both, so it opts in EXPLICITLY (a
      // constructor option only; production code cannot do this).
      addressGuard: { allowAddress: (ip) => ip === "127.0.0.1", allowPort: () => true },
      ...overrides,
    });

  // ----- HTML: unchanged by streaming -----

  test("HTML is read exactly as before: plain, BOM, gzip and redirect give the same text and hash", async () => {
    const svc = service();
    const wantText = svc.htmlToCleanText(HTML);
    const wantHash = sha256(wantText);
    assert.ok(wantText.includes("— £1,270"), "multi-byte characters survive");

    for (const path of ["/plain", "/bom", "/gzip", "/redirect"]) {
      const page = await svc.fetchAndClean(base + path, { checkRobots: true });
      assert.equal(page.cleanText, wantText, path);
      assert.equal(page.contentHash, wantHash, path);
      assert.equal(page.pdf, undefined, path);
      assert.equal(page.httpStatus, 200, path);
    }
    // The redirect's final URL is reported.
    assert.equal((await svc.fetchAndClean(`${base}/redirect`)).finalUrl, `${base}/plain`);
  });

  test("every request carries the bot User-Agent (robots.txt, pages and PDFs)", async () => {
    await service().fetchAndClean(`${base}/doc.pdf`, { checkRobots: true });
    for (const path of ["/robots.txt", "/doc.pdf"]) {
      assert.match(userAgents.get(path) ?? "", /^Seli-VisaCatalogBot\//, path);
    }
  });

  test("HTML over 5 MB is cut off while downloading", async () => {
    await assert.rejects(service().fetchAndClean(`${base}/big-html`), (err: unknown) => {
      assert.equal(isPdfFetchError(err), false);
      assert.match((err as Error).message, new RegExp(`Response too large .* ${MAX_HTML_BYTES}-byte cap`));
      return true;
    });
  });

  test("the HTML cap counts decompressed bytes (a gzip bomb is cut off)", async () => {
    await assert.rejects(service().fetchAndClean(`${base}/gzip-bomb`), /Response too large/);
  });

  test("a stalled body is dropped by the inactivity timer", async () => {
    const started = Date.now();
    await assert.rejects(
      service({ bodyIdleTimeoutMs: 100, bodyTimeoutMs: 30_000 }).fetchAndClean(`${base}/stall`),
      /Response body stalled .* no data for 100 ms/
    );
    assert.ok(Date.now() - started < 5_000, "did not wait for the overall deadline");
  });

  // ----- PDF over a real socket -----

  test("a PDF arrives intact: per-page text, by content type and by .pdf suffix", async () => {
    const svc = service();
    const byType = await svc.fetchAndClean(`${base}/doc.pdf`, { checkRobots: true });
    assert.deepEqual(byType.pdf?.pages, PDF_PAGES);
    assert.equal(byType.pdf?.byteLength, PDF_BYTES.length);
    assert.equal(byType.contentHash, sha256(PDF_PAGES.join("\f")));

    const bySuffix = await svc.fetchAndClean(`${base}/files/generic.pdf`);
    assert.equal(bySuffix.contentHash, byType.contentHash);

    // A web-page URL that redirects to the PDF is read as a PDF too.
    const redirected = await svc.fetchAndClean(`${base}/latest`);
    assert.equal(redirected.finalUrl, `${base}/doc.pdf`);
    assert.equal(redirected.contentHash, byType.contentHash);
  });

  test("an endless PDF download is cut off at the byte cap", async () => {
    const original = console.warn;
    console.warn = () => undefined; // the refusal is logged; keep test output clean
    try {
      await assert.rejects(
        service({ pdf: { maxBytes: 1024 * 1024 } }).fetchAndClean(`${base}/endless.pdf`),
        (err: unknown) => {
          assert.ok(isPdfFetchError(err), String(err));
          assert.equal(err.reason, "too-large");
          assert.equal(err.details.maxBytes, 1024 * 1024);
          return true;
        }
      );
    } finally {
      console.warn = original;
    }
  });

  test("`acceptPdf: false` refuses a PDF on its headers", async () => {
    const original = console.warn;
    console.warn = () => undefined;
    try {
      await assert.rejects(
        service().fetchAndClean(`${base}/endless.pdf`, { acceptPdf: false }),
        (err: unknown) => isPdfFetchError(err) && err.reason === "not-accepted"
      );
    } finally {
      console.warn = original;
    }
  });

  test("an HTML 404 labelled as a PDF fails with its status; a 429 backs off", async () => {
    await assert.rejects(service().fetchAndClean(`${base}/missing.pdf`), /Fetch failed for .* \(HTTP 404\)/);
    await assert.rejects(service().fetchAndClean(`${base}/throttled.pdf`), (err: unknown) => {
      assert.ok(isHostBackoffError(err), String(err));
      assert.equal(err.status, 429);
      return true;
    });
  });
});
