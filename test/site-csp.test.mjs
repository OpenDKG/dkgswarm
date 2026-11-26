import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const siteDir = new URL("../site/", import.meta.url);
const pages = fs.readdirSync(siteDir).filter((file) => file.endsWith(".html"));

test("site pages load no cross-origin script without integrity and no inline script", () => {
  assert.ok(pages.length >= 5);
  for (const page of pages) {
    const html = fs.readFileSync(new URL(page, siteDir), "utf8");
    for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
      const src = /\ssrc=["']([^"']+)["']/i.exec(tag)?.[1];
      assert.ok(src, `${page}: inline <script> is not allowed by the CSP`);
      if (/^(https?:)?\/\//i.test(src)) assert.match(tag, /\sintegrity=["']sha(256|384|512)-/i, `${page}: ${src} needs integrity`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${page}: inline event handler`);
  }
});

test("every site page declares the site-wide CSP and the donation page loads only its own script", () => {
  for (const page of pages) {
    const html = fs.readFileSync(new URL(page, siteDir), "utf8");
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    assert.ok(csp, `${page}: missing CSP`);
    for (const directive of ["default-src 'self'", "script-src 'self';", "object-src 'none'", "base-uri 'self'"]) {
      assert.ok(csp.includes(directive), `${page}: CSP lacks ${directive}`);
    }
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, `${page}: unsafe CSP source`);
  }
  const donate = fs.readFileSync(new URL("donate.html", siteDir), "utf8");
  assert.deepEqual([...donate.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)].map((m) => m[1]), ["/donate-assets/app.js?v=1.6"]);
});
