// Loaded before the unmodified CLI entry point by the owned module boundary.
// Explicit upgrades still work; background update inspection and telemetry do not.
process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"
process.env.OTEL_SDK_DISABLED = "true"
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
delete process.env.OTEL_EXPORTER_OTLP_HEADERS
delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
