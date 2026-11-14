import type { Env } from "./env";

export type ProvisionAction = "up" | "down" | "stop" | "start";

// Start the provisioning workflow on GitHub Actions, which holds the GCP and
// R2 credentials and runs Terraform. Only the box ID is passed; the workflow
// fetches the box's spec from /internal/boxes/:id.
export async function dispatchProvision(env: Env, action: ProvisionAction, boxId: string): Promise<void> {
  if (!env.GITHUB_TOKEN) {
    if (env.DEV === "1") {
      console.log(`[dev] would dispatch ${env.GITHUB_WORKFLOW} action=${action} box_id=${boxId}`);
      return;
    }
    throw new Error("GITHUB_TOKEN is not set");
  }
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "gpushed-api",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { action, box_id: boxId } }),
  });
  if (!r.ok) throw new Error(`GitHub dispatch failed: ${r.status} ${await r.text()}`);
}

export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (env.DEV === "1") {
      console.log(`[dev] email to=${to} subject=${subject}\n${text}`);
      return;
    }
    throw new Error("RESEND_API_KEY is not set");
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
  });
  if (!r.ok) throw new Error(`email send failed: ${r.status} ${await r.text()}`);
}
