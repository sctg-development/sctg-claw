// The gog delivery path, shared by the send_email tool and the command line.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGogArgs, explainGogFailure, type ValidatedMail } from "./mail.js";

const SEND_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: SEND_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES, env }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      // Never fall back to error.message: it embeds the whole command line (recipients, subject, temp paths).
      const killed = (error as { killed?: boolean }).killed;
      resolve({ code, stdout, stderr: stderr || (killed ? "gog timed out" : `gog exited with code ${code} and no message`) });
    });
  });
}

/** Returns a sender that never throws: it resolves { ok, reason }. Bodies go through temp files, removed after. */
export function makeGogSender(options: { gogBinary: string; env: NodeJS.ProcessEnv }) {
  // Same convention as the existing automations: an empty keyring password unless the chart sets one.
  const env: NodeJS.ProcessEnv = { ...options.env, GOG_KEYRING_PASSWORD: options.env.GOG_KEYRING_PASSWORD ?? "" };
  return async (mail: ValidatedMail): Promise<{ ok: boolean; reason: string }> => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "sctg-mail-"));
      const files: { htmlFile?: string; textFile?: string } = {};
      if (mail.bodyHtml) {
        files.htmlFile = path.join(dir, "body.html");
        await writeFile(files.htmlFile, mail.bodyHtml, { mode: 0o600 });
      }
      if (mail.bodyText) {
        files.textFile = path.join(dir, "body.txt");
        await writeFile(files.textFile, mail.bodyText, { mode: 0o600 });
      }
      const result = await run(options.gogBinary, buildGogArgs(mail, files), env);
      return result.code === 0
        ? { ok: true, reason: "" }
        : { ok: false, reason: explainGogFailure(result.stderr || result.stdout) };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    } finally {
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
