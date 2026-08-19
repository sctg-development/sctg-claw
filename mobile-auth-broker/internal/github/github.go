package github

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/models"
)

// GitHub's OAuth device-flow endpoints live on github.com, not api.github.com.
// This is the production default; it is a fixed, non-configurable host for
// real GitHub.com usage (unlike the REST API base, which GITHUB_API_BASE_URL
// can point at a GHE instance for the REST calls below). Tests override it
// via SetOAuthBaseURL to point at a mock server.
const defaultOAuthBaseURL = "https://github.com"

type Client struct {
	clientID     string
	baseURL      string
	oauthBaseURL string
	httpClient   *http.Client
}

func NewClient(clientID, baseURL string) *Client {
	return &Client{
		clientID:     clientID,
		baseURL:      baseURL,
		oauthBaseURL: defaultOAuthBaseURL,
		httpClient:   &http.Client{Timeout: 30 * time.Second},
	}
}

// SetOAuthBaseURL overrides the OAuth device-flow host (github.com by
// default). Intended for tests that point device-flow calls at a mock server.
func (c *Client) SetOAuthBaseURL(url string) {
	c.oauthBaseURL = url
}

// postDeviceFlowForm posts a device-flow request and returns the response
// body. GitHub's device-flow endpoints default to a form-urlencoded response
// body unless the request explicitly asks for JSON, so every device-flow
// call needs an explicit Accept header -- plain http.Client.Post cannot set one.
func (c *Client) postDeviceFlowForm(url, data string) ([]byte, int, error) {
	req, err := http.NewRequest("POST", url, bytes.NewBufferString(data))
	if err != nil {
		return nil, 0, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("failed to read response body: %w", err)
	}
	return body, resp.StatusCode, nil
}

func (c *Client) RequestDeviceAuthorization(scope string) (*models.GitHubDeviceAuth, error) {
	url := fmt.Sprintf("%s/login/device/code", c.oauthBaseURL)
	data := fmt.Sprintf("client_id=%s&scope=%s", c.clientID, scope)

	body, statusCode, err := c.postDeviceFlowForm(url, data)
	if err != nil {
		return nil, fmt.Errorf("failed to request device code: %w", err)
	}

	if statusCode != http.StatusOK {
		return nil, fmt.Errorf("github returned status %d: %s", statusCode, string(body))
	}

	var auth models.GitHubDeviceAuth
	if err := json.Unmarshal(body, &auth); err != nil {
		return nil, fmt.Errorf("failed to decode device auth response: %w", err)
	}

	if auth.DeviceCode == "" || auth.UserCode == "" || auth.VerificationURI == "" {
		return nil, fmt.Errorf("invalid device auth response from GitHub")
	}

	return &auth, nil
}

// PollDeviceAuthorization polls GitHub's device-flow token endpoint. GitHub
// always answers this endpoint with HTTP 200 for a well-formed request; the
// actual outcome (pending, slow_down, denied, expired, or success) is encoded
// in the JSON body's "error" field, never in the HTTP status code.
func (c *Client) PollDeviceAuthorization(deviceCode string) (*models.GitHubToken, *models.GitHubDeviceAuth, error) {
	url := fmt.Sprintf("%s/login/oauth/access_token", c.oauthBaseURL)
	data := fmt.Sprintf("client_id=%s&device_code=%s&grant_type=urn:ietf:params:oauth:grant-type:device_code",
		c.clientID, deviceCode)

	body, statusCode, err := c.postDeviceFlowForm(url, data)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to poll device code: %w", err)
	}

	if statusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("github returned status %d: %s", statusCode, string(body))
	}

	var result struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
		Error       string `json:"error"`
		Interval    int    `json:"interval"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, nil, fmt.Errorf("failed to decode token response: %w", err)
	}

	switch result.Error {
	case "":
		if result.AccessToken == "" {
			return nil, nil, fmt.Errorf("empty access token from GitHub")
		}
		return &models.GitHubToken{
			AccessToken: result.AccessToken,
			TokenType:   result.TokenType,
			Scope:       result.Scope,
		}, nil, nil
	case "authorization_pending":
		return nil, nil, nil
	case "slow_down":
		interval := result.Interval
		if interval <= 0 {
			interval = 5
		}
		return nil, &models.GitHubDeviceAuth{Interval: interval}, nil
	default:
		return nil, nil, fmt.Errorf("github error: %s", result.Error)
	}
}

func (c *Client) GetUserEmails(accessToken string) ([]models.GitHubEmail, error) {
	url := fmt.Sprintf("%s/user/emails", c.baseURL)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get user emails: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github returned status %d: %s", resp.StatusCode, string(body))
	}

	var emails []models.GitHubEmail
	if err := json.NewDecoder(resp.Body).Decode(&emails); err != nil {
		return nil, fmt.Errorf("failed to decode emails: %w", err)
	}

	return emails, nil
}

func (c *Client) RevokeToken(accessToken string) error {
	url := fmt.Sprintf("%s/applications/%s/token", c.baseURL, c.clientID)

	req, err := http.NewRequest("DELETE", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create revoke request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to revoke token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("github returned status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}
