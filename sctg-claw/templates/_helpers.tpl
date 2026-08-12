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
