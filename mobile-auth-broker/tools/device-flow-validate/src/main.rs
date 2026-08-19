//! device-flow-validate
//!
//! Validates the GitHub Device Authorization flow exposed by mobile-auth-broker:
//!
//!   1. GET  /healthz                          → should respond 200
//!   2. POST /v1/device-authorizations         → creates a transaction and
//!      returns {transaction_id, user_code, verification_uri, expires_at,
//!      poll_after_seconds}
//!   3. GET  /v1/device-authorizations/{id}    → polls until a terminal
//!      status: approved | denied | forbidden | expired
//!
//! Exit code: 0 if the full flow ends in "approved", 1 otherwise.

use std::process::ExitCode;
use std::thread::sleep;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use clap::Parser;
use reqwest::blocking::Client;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Models (mirrors of mobile-auth-broker/internal/models/models.go)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DeviceAuthResponse {
    transaction_id: String,
    user_code: String,
    verification_uri: String,
    expires_at: String,
    poll_after_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DeviceAuthStatus {
    status: String,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    access_expires_at: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    refresh_expires_at: Option<String>,
    #[serde(default)]
    subject_email: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(
    name = "device-flow-validate",
    version,
    about = "Validates the GitHub Device Authorization flow of a mobile-auth-broker"
)]
struct Cli {
    /// Base URL of the broker (e.g. https://mobile-claw.ai.pp.ua)
    #[arg(long, value_name = "URL", required = true)]
    url: String,

    /// Overall timeout in seconds (GitHub codes expire after ~15 min)
    #[arg(long, default_value_t = 900)]
    timeout: u64,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn mask(token: &str) -> String {
    let head: String = token.chars().take(6).collect();
    format!("{}… ({} chars)", head, token.chars().count())
}

fn terminal_error(status: &DeviceAuthStatus) -> String {
    match (&status.error, &status.error_message) {
        (Some(e), Some(m)) => format!("{} ({})", m, e),
        (Some(e), None) => e.clone(),
        (None, Some(m)) => m.clone(),
        (None, None) => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Validation steps
// ---------------------------------------------------------------------------

fn check_health(client: &Client, base: &str) -> Result<()> {
    let url = format!("{}/healthz", base);
    let resp = client.get(&url).send().context("GET /healthz failed")?;
    if !resp.status().is_success() {
        bail!("/healthz responded {}", resp.status());
    }
    Ok(())
}

fn create_device_authorization(client: &Client, base: &str) -> Result<DeviceAuthResponse> {
    let url = format!("{}/v1/device-authorizations", base);
    let resp = client
        .post(&url)
        .send()
        .context("POST /v1/device-authorizations failed")?;

    let status = resp.status();
    let body = resp.text().context("failed to read response body")?;

    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<ErrorBody>(&body) {
            bail!(
                "POST responded {} : {} {}",
                status,
                err.error.unwrap_or_default(),
                err.error_message.unwrap_or_default()
            );
        }
        bail!("POST responded {} : {}", status, body.trim());
    }

    let auth: DeviceAuthResponse =
        serde_json::from_str(&body).context("invalid JSON response body")?;

    // Structural validations
    if auth.transaction_id.is_empty() {
        bail!("empty transaction_id in response");
    }
    if auth.user_code.is_empty() {
        bail!("empty user_code in response");
    }
    if !auth.verification_uri.starts_with("https://github.com/") {
        eprintln!(
            "  ! warning: unexpected verification_uri: {}",
            auth.verification_uri
        );
    }
    if !(4..=10).contains(&auth.user_code.len()) && !auth.user_code.contains('-') {
        eprintln!(
            "  ! warning: unusual user_code format: {}",
            auth.user_code
        );
    }

    Ok(auth)
}

fn poll(client: &Client, base: &str, auth: &DeviceAuthResponse, timeout_secs: u64) -> Result<DeviceAuthStatus> {
    let url = format!("{}/v1/device-authorizations/{}", base, auth.transaction_id);
    let started = Instant::now();
    let deadline = Duration::from_secs(timeout_secs);
    let mut interval = Duration::from_secs(auth.poll_after_seconds.max(1));
    let mut consecutive_errors = 0u32;

    loop {
        if started.elapsed() >= deadline {
            bail!(
                "overall timeout of {}s reached — final status: pending",
                timeout_secs
            );
        }

        sleep(interval);

        match client.get(&url).send() {
            Ok(resp) => {
                consecutive_errors = 0;
                let body = resp.text().unwrap_or_default();
                let status: DeviceAuthStatus = serde_json::from_str(&body)
                    .with_context(|| format!("invalid JSON status: {}", body.trim()))?;

                let elapsed = started.elapsed().as_secs();
                match status.status.as_str() {
                    "pending" => {
                        println!("  … pending (t+{}s)", elapsed);
                    }
                    "slow_down" => {
                        interval += Duration::from_secs(5);
                        println!(
                            "  … slow_down (t+{}s) — interval increased to {}s",
                            elapsed,
                            interval.as_secs()
                        );
                    }
                    "approved" => return Ok(status),
                    "denied" | "forbidden" | "expired" => return Ok(status),
                    other => {
                        bail!("unexpected status: {}", other);
                    }
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                eprintln!("  ! network error ({}) — attempt {}", e, consecutive_errors);
                if consecutive_errors >= 5 {
                    bail!("5 consecutive errors, aborting: {}", e);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("\n✗ FAILURE: {:#}", e);
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();

    // Base URL normalization
    let raw = cli.url.trim_end_matches('/');
    if !(raw.starts_with("https://") || raw.starts_with("http://")) {
        bail!("URL must start with http:// or https://");
    }
    let base = raw.to_string();

    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("device-flow-validate/0.1")
        .build()?;

    println!("Target: {}", base);

    // Step 1 — healthz
    print!("[1/3] GET {}/healthz … ", base);
    check_health(&client, &base)?;
    println!("OK");

    // Step 2 — create transaction
    println!("[2/3] POST {}/v1/device-authorizations …", base);
    let auth = create_device_authorization(&client, &base)?;
    println!("  ✓ transaction_id    : {}", auth.transaction_id);
    println!("  ✓ user_code         : {}", auth.user_code);
    println!("  ✓ verification_uri  : {}", auth.verification_uri);
    println!("  ✓ expires_at        : {}", auth.expires_at);
    println!("  ✓ poll_after_seconds: {}", auth.poll_after_seconds);

    println!(
        "\n>>> Action required: open {} and enter code {}",
        auth.verification_uri, auth.user_code
    );

    // Step 3 — polling
    println!(
        "[3/3] Polling GET {}/v1/device-authorizations/{} every {}s …",
        base, auth.transaction_id, auth.poll_after_seconds
    );
    let status = poll(&client, &base, &auth, cli.timeout)?;

    let detail = terminal_error(&status);
    match status.status.as_str() {
        "approved" => {
            println!("\n✓ SUCCESS: approved status");
            if let Some(email) = &status.subject_email {
                println!("  email            : {}", email);
            }
            match &status.access_token {
                Some(t) => println!("  access_token     : {}", mask(t)),
                None => bail!("approved response without access_token"),
            }
            if let Some(exp) = &status.access_expires_at {
                println!("  access_expires_at: {}", exp);
            }
            match &status.refresh_token {
                Some(t) => println!("  refresh_token    : {}", mask(t)),
                None => bail!("approved response without refresh_token"),
            }
            if let Some(exp) = &status.refresh_expires_at {
                println!("  refresh_expires_at: {}", exp);
            }
            Ok(())
        }
        other => {
            if detail.is_empty() {
                bail!("terminal status: {}", other);
            }
            bail!("terminal status: {} — {}", other, detail);
        }
    }
}
