import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultImageRoots, loadInlineImages, withLoadedImages } from "./inline-images.ts";
import { buildGogArgs, validateInlineRequests, validateMail } from "./mail.ts";
import { buildRawMessage } from "./raw-message.ts";
import { sendWithFallback, stripCidImages, type Deps, type SmtpMessage } from "./transports.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const config = { defaultAccount: "sender@example.org" };
const html = '<p>Café</p><img src="cid:coach-gauge" alt="Recovery 72/100"><img src="cid:b">';

async function sandbox() {
  const root = await mkdtemp(path.join(tmpdir(), "mail-img-"));
  const charts = path.join(root, "charts");
  await mkdir(charts);
  await writeFile(path.join(charts, "gauge.png"), PNG);
  await writeFile(path.join(root, "secret.png"), PNG);
  await writeFile(path.join(charts, "fake.png"), "not an image at all");
  return { root, charts, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("requests are validated: shape, uniqueness, extension, and a reference in the HTML", () => {
  const ok = validateInlineRequests([{ cid: "coach-gauge", path: "/x/gauge.png" }], html);
  assert.ok(ok.ok);
  const bad = (value: unknown, body: string | undefined = html) => String((validateInlineRequests(value, body) as { error?: string }).error);
  assert.match(bad([{ cid: "a b", path: "/x/a.png" }]), /invalid inline image cid/);
  assert.match(bad([{ cid: "coach-gauge", path: "/x/a.png" }, { cid: "coach-gauge", path: "/x/b.png" }]), /duplicate/);
  assert.match(bad([{ cid: "coach-gauge", path: "/x/a.svg" }]), /\.png or \.jpg/);
  assert.match(bad([{ cid: "unused", path: "/x/a.png" }]), /not referenced/);
  assert.match(bad([{ cid: "coach-gauge", path: "/x/a.png" }], ""), /need bodyHtml/);
  assert.match(bad(Array.from({ length: 9 }, (_, i) => ({ cid: `c${i}`, path: "/x/a.png" }))), /too many/);
  assert.deepEqual(validateInlineRequests(undefined, html), { ok: true, images: [] });
});

test("images are only read from allowed folders, as real PNG/JPEG files, even through symlinks", async () => {
  const { root, charts, cleanup } = await sandbox();
  try {
    const good = await loadInlineImages([{ cid: "coach-gauge", path: path.join(charts, "gauge.png") }], [charts]);
    assert.ok(good.ok && good.images[0].contentType === "image/png" && good.images[0].content.equals(PNG));
    const outside = await loadInlineImages([{ cid: "a", path: path.join(root, "secret.png") }], [charts]);
    assert.match(String((outside as { error?: string }).error), /outside the allowed folders/);
    const traversal = await loadInlineImages([{ cid: "a", path: path.join(charts, "..", "secret.png") }], [charts]);
    assert.match(String((traversal as { error?: string }).error), /outside/);
    await symlink(path.join(root, "secret.png"), path.join(charts, "link.png"));
    const linked = await loadInlineImages([{ cid: "a", path: path.join(charts, "link.png") }], [charts]);
    assert.match(String((linked as { error?: string }).error), /outside/);
    const fake = await loadInlineImages([{ cid: "a", path: path.join(charts, "fake.png") }], [charts]);
    assert.match(String((fake as { error?: string }).error), /not a PNG or JPEG/);
    const missing = await loadInlineImages([{ cid: "a", path: path.join(charts, "nope.png") }], [charts]);
    assert.match(String((missing as { error?: string }).error), /not found/);
    const noRoot = await loadInlineImages([{ cid: "a", path: path.join(charts, "gauge.png") }], [path.join(root, "absent")]);
    assert.match(String((noRoot as { error?: string }).error), /outside/);
    assert.deepEqual(defaultImageRoots("/home/node"), ["/home/node/.openclaw/coach/charts"]);
  } finally {
    await cleanup();
  }
});

async function loadedMail(charts: string, over: Record<string, unknown> = {}) {
  const v = validateMail({ to: ["ops@example.org"], bcc: ["hidden@example.org"], subject: "Briefing du jour — récupération", bodyHtml: html, bodyText: "texte", inlineImages: [{ cid: "coach-gauge", path: path.join(charts, "gauge.png") }, { cid: "b", path: path.join(charts, "gauge.png") }], ...over }, config);
  assert.ok(v.ok);
  const loaded = await withLoadedImages(v.mail, [charts]);
  assert.ok(loaded.ok);
  return loaded.mail;
}

test("the raw message has the inline images in a multipart/related part, keeps Bcc, and encodes accents", async () => {
  const { charts, cleanup } = await sandbox();
  try {
    const raw = (await buildRawMessage(await loadedMail(charts), "sender@example.org")).toString("utf8");
    assert.match(raw, /^From: sender@example\.org/m);
    assert.match(raw, /^To: ops@example\.org/m);
    assert.match(raw, /^Bcc: hidden@example\.org/m);
    assert.match(raw, /^Subject: =\?UTF-8\?/m);
    assert.match(raw, /multipart\/related/);
    assert.match(raw, /multipart\/alternative/);
    assert.match(raw, /Content-ID: <coach-gauge>/);
    assert.match(raw, /Content-Type: image\/png; name=gauge\.png/);
    assert.match(raw, /Content-Disposition: inline/);
    assert.ok(raw.includes(PNG.toString("base64").slice(0, 40)));
  } finally {
    await cleanup();
  }
});

test("gog gets only --raw-file when images are present, and the usual flags otherwise", async () => {
  const { charts, cleanup } = await sandbox();
  try {
    const withImages = buildGogArgs(await loadedMail(charts), { rawFile: "/tmp/m.eml" });
    assert.deepEqual(withImages.slice(0, 5), ["--account", "sender@example.org", "--enable-commands-exact", "gmail.send", "--no-input"]);
    assert.deepEqual(withImages.slice(-4), ["gmail", "send", "--raw-file", "/tmp/m.eml"]);
    for (const flag of ["--to", "--subject", "--bcc", "--body-html-file"]) assert.ok(!withImages.includes(flag), flag);
    const plain = validateMail({ to: ["a@example.org"], subject: "S", bodyHtml: "<p>x</p>" }, config);
    assert.ok(plain.ok);
    assert.ok(buildGogArgs(plain.mail, { htmlFile: "/tmp/b.html" }).includes("--body-html-file"));
  } finally {
    await cleanup();
  }
});

test("SMTP fallback carries the images, Cloudflare's gets alt text instead of broken pictures", async () => {
  const { charts, cleanup } = await sandbox();
  try {
    const mail = await loadedMail(charts, { bcc: undefined, to: ["ops@example.org"] });
    const smtp: SmtpMessage[] = [];
    const cf: Array<{ html?: string }> = [];
    const deps: Deps = {
      sendViaGog: async () => ({ ok: false, reason: "token expired" }),
      smtpSend: async (_cfg, message) => {
        smtp.push(message);
      },
      fetch: (async (_url: string, init: { body: string }) => {
        cf.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true, result: { delivered: ["ops@example.org"] } }), { status: 200 });
      }) as unknown as typeof fetch,
    };
    const base = { recipients: ["ops@example.org"] };
    const viaSmtp = await sendWithFallback(mail, { ...base, smtp: { host: "h", port: 587, user: "u", password: "pw", from: "u" } }, deps);
    assert.ok(viaSmtp.ok && viaSmtp.transport === "smtp");
    assert.equal(smtp[0].inlineImages?.length, 2);
    const viaCf = await sendWithFallback(mail, { ...base, cloudflare: { accountId: "a", token: "t", from: "f@example.org" } }, deps);
    assert.ok(viaCf.ok && viaCf.transport === "cloudflare");
    assert.ok(!cf[0].html?.includes("cid:"));
    assert.match(String(cf[0].html), /\[Recovery 72\/100\]/);
  } finally {
    await cleanup();
  }
});

test("stripCidImages leaves ordinary images alone", () => {
  assert.equal(stripCidImages('<img src="https://x/y.png" alt="a">'), '<img src="https://x/y.png" alt="a">');
  assert.equal(stripCidImages("<img src='cid:z'>"), "");
});
