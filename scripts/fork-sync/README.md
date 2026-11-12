# fork-sync-watch

Cron OpenClaw (commande, sans IA) qui pilote la synchronisation des forks avec leur amont :

1. lance le workflow GitHub Actions `fork-sync.yml` de chaque fork (`workflow_dispatch`) ;
2. suit le run jusqu'à la fin ;
3. lit le résultat de l'agent (artefact `fork-sync-<run>`) ;
4. envoie **un mail par synchronisation** (via `sctg-mail` : gog, puis les secours SMTP et Cloudflare).

L'agent (Claude Code, dans GitHub Actions) ne fusionne jamais : il ouvre une PR **en brouillon**.
Le workflow n'a volontairement **pas de `schedule:`** : ce cron est le seul déclencheur, sinon le run
partirait deux fois et un seul des deux enverrait un mail.

## Mise en place

### 1. Jeton GitHub

Un jeton **fine-grained** (Settings → Developer settings → Fine-grained tokens), avec :

- *Repository access* : uniquement les forks synchronisés (`TEA-ching/kilocode`, `sctg-development/mistral-vibe`, …) ;
- *Permissions* : **Actions : Read and write**. Rien d'autre (pas de Contents, ni de Pull requests, ni d'Administration) ;
- une expiration (1 an) ; ajoutez la date à votre agenda.

Ce jeton peut lancer des workflows, pas modifier du code. Un workflow ne s'exécute que depuis la branche par défaut.
Un jeton fine-grained ne couvre **qu'un seul propriétaire** : créez-en un par propriétaire (par exemple un pour
`TEA-ching`, un pour `sctg-development`). Un jeton classique `workflow` couvrirait tout, mais il est bien plus large :
déconseillé.

Valeurs SOPS (sous `claw.openclaw.secret`) :

```yaml
forkSyncGithubToken: github_pat_...        # jeton par défaut -> FORK_SYNC_GH_TOKEN
forkSyncGithubTokens:                      # un jeton par propriétaire, prioritaire sur le défaut
  sctg-development: github_pat_...         # -> FORK_SYNC_GH_TOKEN_SCTG_DEVELOPMENT
```

Un fork sans jeton utilisable reçoit son propre mail d'erreur ; les autres continuent.

### 2. Le cron

```bash
openclaw cron add --name fork-sync-watch --display-name "Synchro des forks" --every 7d \
  --declaration-key fork-sync-watch \
  --command 'node /opt/fork-sync/fork-sync-watch.mjs --to <destinataire> --account <expéditeur-gog> --repos TEA-ching/kilocode,sctg-development/mistral-vibe'
```

Sans `--repos`, la liste par défaut (`FORK_SYNC_REPOS`) est utilisée. Ajoutez un fork seulement quand son
workflow `fork-sync.yml` est fusionné sur sa branche par défaut : sinon le mail dit « n'existe pas encore ».

Options : `--mode dry-run` (rien n'est modifié), `--skip-up-to-date` (pas de mail quand il n'y a rien à faire),
`--timeout-min` (180 par défaut), `--dry-mail` (affiche les mails sans les envoyer).

### 3. Essai

```bash
node /opt/fork-sync/fork-sync-watch.mjs --to <destinataire> --repos TEA-ching/kilocode --mode dry-run --dry-mail
```

Code de sortie : `0` terminé, `2` usage ou jeton absent, `3` au moins un mail non délivré.

## Sécurité

- Les `notes` de l'agent viennent du contenu amont, donc non fiables : elles sont affichées en texte échappé
  et tronqué, jamais interprétées.
- Un run rouge ne peut jamais être présenté comme « synchronisé », quel que soit le fichier de résultat.
- Le jeton n'est jamais écrit dans un log ni dans un mail.
