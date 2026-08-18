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

// Custom status code for GitHub Device Flow
const StatusAuthorizationPending = 202

type Client struct {
	clientID   string
	baseURL    string
	httpClient *http.Client
}

func NewClient(clientID, baseURL string) *Client {
	return &Client{
		clientID:   clientID,
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) RequestDeviceAuthorization(scope string) (*models.GitHubDeviceAuth, error) {
	url := fmt.Sprintf("%s/login/oauth/device/code", c.baseURL)

	data := fmt.Sprintf("client_id=%s&scope=%s", c.clientID, scope)
	resp, err := c.httpClient.Post(url, "application/x-www-form-urlencoded", bytes.NewBufferString(data))
	if err != nil {
		return nil, fmt.Errorf("failed to request device code: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github returned status %d: %s", resp.StatusCode, string(body))
	}

	var auth models.GitHubDeviceAuth
	if err := json.NewDecoder(resp.Body).Decode(&auth); err != nil {
		return nil, fmt.Errorf("failed to decode device auth response: %w", err)
	}

	if auth.DeviceCode == "" || auth.UserCode == "" || auth.VerificationURI == "" {
		return nil, fmt.Errorf("invalid device auth response from GitHub")
	}

	return &auth, nil
}

func (c *Client) PollDeviceAuthorization(deviceCode string) (*models.GitHubToken, *models.GitHubDeviceAuth, error) {
	url := fmt.Sprintf("%s/login/oauth/device/access_token", c.baseURL)

	data := fmt.Sprintf("client_id=%s&device_code=%s&grant_type=urn:ietf:params:oauth:grant-type:device_code",
		c.clientID, deviceCode)

	resp, err := c.httpClient.Post(url, "application/x-www-form-urlencoded", bytes.NewBufferString(data))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to poll device code: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == StatusAuthorizationPending {
		// Still pending, check for slow_down
		var auth models.GitHubDeviceAuth
		if err := json.Unmarshal(body, &auth); err == nil && auth.Interval > 0 {
			return nil, &auth, nil
		}
		return nil, nil, nil
	}

	if resp.StatusCode == http.StatusBadRequest {
		// Check for slow_down or other errors
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err == nil {
			if errorMsg, ok := result["error"].(string); ok {
				if errorMsg == "slow_down" {
					// Parse the interval from the response
					var interval int = 5
					if intervalVal, ok := result["interval"]; ok {
						if iv, ok := intervalVal.(float64); ok {
							interval = int(iv)
						}
					}
					return nil, &models.GitHubDeviceAuth{Interval: interval}, nil
				}
				if errorMsg == "authorization_pending" {
					return nil, nil, nil
				}
				return nil, nil, fmt.Errorf("github error: %s", errorMsg)
			}
		}
		return nil, nil, fmt.Errorf("github returned error: %s", string(body))
	}

	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("github returned status %d: %s", resp.StatusCode, string(body))
	}

	var token models.GitHubToken
	if err := json.NewDecoder(bytes.NewReader(body)).Decode(&token); err != nil {
		return nil, nil, fmt.Errorf("failed to decode token response: %w", err)
	}

	if token.AccessToken == "" {
		return nil, nil, fmt.Errorf("empty access token from GitHub")
	}

	return &token, nil, nil
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
