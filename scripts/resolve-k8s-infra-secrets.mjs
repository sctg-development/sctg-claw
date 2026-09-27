#!/usr/bin/env node
// Two jobs for the k8s-ops plugin, both no-ops when their secret is unset so
// this is always safe to run before the gateway starts:
//
// 1. Writes the kubeconfig for a scoped cluster ServiceAccount (see
//    k8s-infra/argocd/addons/k8s-ops-rbac/) from K8S_INFRA_KUBECONFIG to disk
//    -- kubeconfig content is multi-line YAML, so unlike a plain token it
//    needs to land in a real file for kubectl/argocd --core to read
//    (KUBECONFIG=path). Sourced via envFrom like every other *_API_KEYS/
//    *_TOKEN value -- see sctg-claw/templates/openclaw-secret.yaml.
// 2. Clones (or pulls, if already present -- this runs on every container
//    start) the k8s-infra GitOps repo itself into the OpenClaw workspace
//    using a read-only deploy key from K8S_INFRA_GIT_SSH_KEY, so the agent
//    can read the actual current Ansible playbooks/inventories and ArgoCD
//    Application manifests -- the real GitOps source of truth -- instead of
//    reasoning only from ArgoCD's already-applied cluster state. This key is
//    deliberately separate from k8s-infra/.k8s-infra-secrets/argocd-deploy-key
//    (which stays ArgoCD's own, in-cluster-only credential).
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_KUBECONFIG_PATH = "/home/node/.kube/config";
const DEFAULT_GIT_SSH_KEY_PATH = "/home/node/.ssh/k8s_infra_git_ed25519";
const DEFAULT_REPO_URL = "git@github.com:aeltorio/k8s-infra.git";
const DEFAULT_REPO_PATH = "/home/node/.openclaw/workspace/k8s-infra";
const GIT_TIMEOUT_MS = 60_000;

async function writeKubeconfig() {
  const kubeconfig = process.env.K8S_INFRA_KUBECONFIG;
  if (!kubeconfig) {
    return;
  }
  const destPath = process.env.K8S_INFRA_KUBECONFIG_PATH || DEFAULT_KUBECONFIG_PATH;
  try {
    await mkdir(path.dirname(destPath), { recursive: true, mode: 0o700 });
    await writeFile(destPath, kubeconfig.endsWith("\n") ? kubeconfig : `${kubeconfig}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`resolve-k8s-infra-secrets: could not write kubeconfig to ${destPath}: ${error.message}`);
  }
}

async function syncGitOpsRepo() {
  const sshKey = process.env.K8S_INFRA_GIT_SSH_KEY;
  if (!sshKey) {
    return;
  }
  const keyPath = process.env.K8S_INFRA_GIT_SSH_KEY_PATH || DEFAULT_GIT_SSH_KEY_PATH;
  const repoUrl = process.env.K8S_INFRA_GIT_REPO_URL || DEFAULT_REPO_URL;
  const repoPath = process.env.K8S_INFRA_GIT_REPO_PATH || DEFAULT_REPO_PATH;

  try {
    await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    await writeFile(keyPath, sshKey.endsWith("\n") ? sshKey : `${sshKey}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`resolve-k8s-infra-secrets: could not write git deploy key to ${keyPath}: ${error.message}`);
    return;
  }

  // -i alone is not enough: the account's other keys (if any) or ssh-agent
  // identities must not be offered first and fail the (usually rate-limited)
  // auth attempt before this one is tried. accept-new is a pragmatic default
  // for a personal, non-multi-tenant deploy key -- pin known_hosts instead if
  // this ever needs to be hardened further.
  const gitSshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  const env = { ...process.env, GIT_SSH_COMMAND: gitSshCommand };

  try {
    await execFileAsync("test", ["-d", path.join(repoPath, ".git")]);
    await execFileAsync("git", ["-C", repoPath, "pull", "--ff-only"], { env, timeout: GIT_TIMEOUT_MS });
  } catch {
    try {
      await mkdir(path.dirname(repoPath), { recursive: true });
      await execFileAsync("git", ["clone", "--depth", "1", repoUrl, repoPath], { env, timeout: GIT_TIMEOUT_MS });
    } catch (error) {
      console.error(`resolve-k8s-infra-secrets: could not sync ${repoUrl} to ${repoPath}: ${error.message}`);
    }
  }
}

await writeKubeconfig();
await syncGitOpsRepo();
