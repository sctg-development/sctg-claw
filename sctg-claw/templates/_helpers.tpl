{{- define "claw.name" -}}
{{- default .Chart.Name .Values.nameOverride }}
{{- end -}}

{{- define "claw.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- printf "%s" .Values.fullnameOverride }}
{{- else }}
{{- printf "%s-%s" (include "claw.name" .) .Release.Name }}
{{- end }}
{{- end -}}

{{- define "claw.labels" -}}
app.kubernetes.io/name: {{ include "claw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "claw.openclawSecretName" -}}
{{- if .Values.openclaw.secret.create }}
{{- default (printf "%s-providers" (include "claw.fullname" .)) .Values.openclaw.secret.name }}
{{- else }}
{{- .Values.openclaw.existingSecret }}
{{- end }}
{{- end -}}

{{- define "claw.openclawConfigMapName" -}}
{{- printf "%s-config" (include "claw.fullname" .) }}
{{- end -}}

{{- /*
Renders exactly one provider API-key env var from a comma/semicolon-separated
value: <envName>_API_KEY for a single key, <envName>_API_KEYS for a pool of
more than one. openclaw's env-based auth resolver already falls back from the
singular to the plural var and takes its first entry, so declaring both for a
single key (or the plural for a pool) is redundant.
Usage: {{ include "claw.providerApiKeyEnv" (dict "envName" "MISTRAL" "raw" .) }}
*/ -}}
{{- define "claw.providerApiKeyEnv" -}}
{{- $parts := list -}}
{{- range regexSplit "[,;]" .raw -1 -}}
{{- $trimmed := trim . -}}
{{- if $trimmed -}}
{{- $parts = append $parts $trimmed -}}
{{- end -}}
{{- end -}}
{{- if gt (len $parts) 1 -}}
{{ .envName }}_API_KEYS: {{ .raw | quote }}
{{- else -}}
{{ .envName }}_API_KEY: {{ first $parts | quote }}
{{- end -}}
{{- end -}}

{{- /* Mobile Auth Broker helpers */ -}}
{{- define "claw.mobileAuthBrokerSecretName" -}}
{{- if .Values.mobileAuthBroker.existingSecret }}
{{- .Values.mobileAuthBroker.existingSecret }}
{{- else }}
{{- default (printf "%s-mobile-auth-broker" (include "claw.fullname" .)) .Values.mobileAuthBroker.secret.name }}
{{- end }}
{{- end -}}

{{- define "claw.mobileAuthBrokerAllowedEmailsConfigMapName" -}}
{{- default (printf "%s-mobile-auth-broker-allowed-emails" (include "claw.fullname" .)) .Values.mobileAuthBroker.allowedEmailsConfigMap.name }}
{{- end -}}

{{- define "claw.mobileAuthBrokerPVCName" -}}
{{- default (printf "%s-mobile-auth-broker" (include "claw.fullname" .)) .Values.mobileAuthBroker.persistence.existingClaim }}
{{- end -}}

{{/* Name of the ServiceAccount the claw pod runs as (same rule as the Deployment). */}}
{{- define "claw.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "claw.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name must be set when serviceAccount.create is false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end }}

{{/*
Generate the mc alias setup commands as a single shell script string.
*/}}
{{- define "claw.mcAliasSetupCmd" -}}
{{- range $aliasName, $alias := .Values.openclaw.mc.aliases }}
echo "Setting up mc alias: {{ $aliasName }}"
mc alias set "{{ $aliasName }}" "{{ $alias.endpoint }}" "{{ $alias.accessKey }}" "{{ $alias.secretKey }}"
{{- end }}
{{- end -}}

{{/*
kubeconfig that authenticates with the pod's own ServiceAccount token (tokenFile is re-read, so Kubernetes'
automatic rotation just works). It contains NO secret: only paths and the API server address.
*/}}
{{- define "claw.k8sOpsKubeconfig" -}}
apiVersion: v1
kind: Config
clusters:
  - name: in-cluster
    cluster:
      server: {{ .Values.openclaw.k8sOps.inCluster.server | default "https://kubernetes.default.svc" }}
      certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
users:
  - name: claw-k8s-ops
    user:
      tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
contexts:
  - name: in-cluster
    context:
      cluster: in-cluster
      user: claw-k8s-ops
current-context: in-cluster
{{- end }}
