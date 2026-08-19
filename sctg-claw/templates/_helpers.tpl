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
