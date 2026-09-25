// Package tlscert self-manages a publicly-trusted TLS certificate for the
// broker via ACME DNS-01 against Cloudflare DNS, using the go-acme/lego
// library directly -- no external `lego`/certbot process, no cirond
// supervision, no file-watching reload. Everything (issuance, on-disk
// caching, and background renewal) lives in this one long-running process.
//
// This exists because the official OpenClaw native clients (see
// CloudflareAccessLogin.swift's validateGateway in the macOS app) hard-require
// an https:// gateway URL for their sign-in flow; ws:///http:// endpoints are
// rejected client-side before a connection is even attempted. A tailnet
// MagicDNS hostname has no browser-trusted certificate of its own -- Headscale
// deployments commonly don't support `tailscale cert` (no ACME configured
// server-side) -- so the broker obtains a real Let's Encrypt certificate
// itself instead.
package tlscert

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/go-acme/lego/v4/certcrypto"
	"github.com/go-acme/lego/v4/certificate"
	"github.com/go-acme/lego/v4/challenge/dns01"
	"github.com/go-acme/lego/v4/lego"
	"github.com/go-acme/lego/v4/providers/dns/cloudflare"
	"github.com/go-acme/lego/v4/registration"
)

// propagationNameservers are used to check the DNS-01 TXT record has
// propagated before telling Let's Encrypt to validate it. lego defaults to
// whatever /etc/resolv.conf points at, which inside a Kubernetes pod is the
// cluster's own CoreDNS -- an in-cluster resolver has no particular reason to
// see a record that was just created on Cloudflare's authoritative servers
// promptly (or, in a pod also running tailscaled, resolv.conf may point at
// Tailscale's MagicDNS resolver instead, which has the same problem for a
// public record). Querying Cloudflare's own public resolvers directly
// sidesteps both: the record is already live there the moment the API call
// that created it returns.
var propagationNameservers = []string{"1.1.1.1:53", "1.0.0.1:53"}

// renewBefore is how far ahead of expiry a certificate is renewed.
const renewBefore = 30 * 24 * time.Hour

// checkInterval is how often the background loop checks whether renewal is due.
const checkInterval = 12 * time.Hour

type acmeUser struct {
	email        string
	registration *registration.Resource
	key          crypto.PrivateKey
}

func (u *acmeUser) GetEmail() string                        { return u.email }
func (u *acmeUser) GetRegistration() *registration.Resource { return u.registration }
func (u *acmeUser) GetPrivateKey() crypto.PrivateKey        { return u.key }

// Manager obtains and renews a Let's Encrypt certificate for one domain via
// ACME DNS-01 against Cloudflare, and serves it to TLS listeners through
// GetCertificate.
type Manager struct {
	domain     string
	email      string
	cfAPIToken string
	cacheDir   string
	staging    bool

	cert atomic.Pointer[tls.Certificate]
}

func NewManager(domain, email, cfAPIToken, cacheDir string, staging bool) *Manager {
	return &Manager{
		domain:     domain,
		email:      email,
		cfAPIToken: cfAPIToken,
		cacheDir:   cacheDir,
		staging:    staging,
	}
}

// Start loads a cached certificate if it's still valid for a while, otherwise
// obtains a new one synchronously (blocking startup -- there is nothing
// useful to serve on the TLS listeners without it), then launches a
// background renewal loop.
func (m *Manager) Start() error {
	if err := os.MkdirAll(m.cacheDir, 0o700); err != nil {
		return fmt.Errorf("creating TLS cert cache dir: %w", err)
	}

	if cert, err := m.loadCached(); err == nil && !m.needsRenewal(cert) {
		m.cert.Store(cert)
		log.Printf("INFO: loaded cached TLS certificate for %s (expires %s)", m.domain, cert.Leaf.NotAfter.Format(time.RFC3339))
	} else if err := m.obtain(); err != nil {
		return fmt.Errorf("obtaining initial TLS certificate for %s: %w", m.domain, err)
	}

	go m.renewLoop()
	return nil
}

func (m *Manager) renewLoop() {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for range ticker.C {
		cert := m.cert.Load()
		if cert != nil && !m.needsRenewal(cert) {
			continue
		}
		if err := m.obtain(); err != nil {
			// The previous certificate (still loaded in m.cert) keeps serving
			// until the next check; only actual expiry causes an outage.
			log.Printf("ERROR: TLS certificate renewal failed for %s: %v", m.domain, err)
		}
	}
}

func (m *Manager) needsRenewal(cert *tls.Certificate) bool {
	return time.Until(cert.Leaf.NotAfter) < renewBefore
}

// GetCertificate implements tls.Config.GetCertificate.
func (m *Manager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	cert := m.cert.Load()
	if cert == nil {
		return nil, fmt.Errorf("no TLS certificate available yet for %s", m.domain)
	}
	return cert, nil
}

func (m *Manager) certPath() string       { return filepath.Join(m.cacheDir, m.domain+".crt") }
func (m *Manager) keyPath() string        { return filepath.Join(m.cacheDir, m.domain+".key") }
func (m *Manager) accountKeyPath() string { return filepath.Join(m.cacheDir, "account.key") }

func (m *Manager) loadCached() (*tls.Certificate, error) {
	cert, err := tls.LoadX509KeyPair(m.certPath(), m.keyPath())
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, err
	}
	cert.Leaf = leaf
	return &cert, nil
}

// loadOrCreateAccountKey persists the ACME *account* key (not the
// certificate key) so restarts re-use the same Let's Encrypt account instead
// of registering a new one every time. Re-registering with the same key is
// safe either way -- Let's Encrypt's newAccount endpoint returns the existing
// account for a known key -- this just avoids that extra round trip.
func (m *Manager) loadOrCreateAccountKey() (crypto.PrivateKey, error) {
	if data, err := os.ReadFile(m.accountKeyPath()); err == nil {
		if block, _ := pem.Decode(data); block != nil {
			if key, err := x509.ParseECPrivateKey(block.Bytes); err == nil {
				return key, nil
			}
		}
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generating account key: %w", err)
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encoding account key: %w", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	if err := os.WriteFile(m.accountKeyPath(), pemBytes, 0o600); err != nil {
		return nil, fmt.Errorf("writing account key: %w", err)
	}
	return key, nil
}

func (m *Manager) obtain() error {
	log.Printf("INFO: requesting TLS certificate for %s via ACME DNS-01 (Cloudflare)", m.domain)

	accountKey, err := m.loadOrCreateAccountKey()
	if err != nil {
		return err
	}

	user := &acmeUser{email: m.email, key: accountKey}
	legoConfig := lego.NewConfig(user)
	if m.staging {
		legoConfig.CADirURL = lego.LEDirectoryStaging
	}
	legoConfig.Certificate.KeyType = certcrypto.RSA2048

	client, err := lego.NewClient(legoConfig)
	if err != nil {
		return fmt.Errorf("creating ACME client: %w", err)
	}

	cfConfig := cloudflare.NewDefaultConfig()
	cfConfig.AuthToken = m.cfAPIToken
	provider, err := cloudflare.NewDNSProviderConfig(cfConfig)
	if err != nil {
		return fmt.Errorf("configuring Cloudflare DNS-01 provider: %w", err)
	}
	if err := client.Challenge.SetDNS01Provider(provider, dns01.AddRecursiveNameservers(propagationNameservers)); err != nil {
		return fmt.Errorf("registering DNS-01 provider: %w", err)
	}

	reg, err := client.Registration.Register(registration.RegisterOptions{TermsOfServiceAgreed: true})
	if err != nil {
		return fmt.Errorf("registering ACME account: %w", err)
	}
	user.registration = reg

	result, err := client.Certificate.Obtain(certificate.ObtainRequest{
		Domains: []string{m.domain},
		Bundle:  true,
	})
	if err != nil {
		return fmt.Errorf("obtaining certificate: %w", err)
	}

	if err := os.WriteFile(m.certPath(), result.Certificate, 0o600); err != nil {
		return fmt.Errorf("writing certificate: %w", err)
	}
	if err := os.WriteFile(m.keyPath(), result.PrivateKey, 0o600); err != nil {
		return fmt.Errorf("writing private key: %w", err)
	}

	cert, err := tls.X509KeyPair(result.Certificate, result.PrivateKey)
	if err != nil {
		return fmt.Errorf("parsing obtained certificate: %w", err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return fmt.Errorf("parsing certificate leaf: %w", err)
	}
	cert.Leaf = leaf
	m.cert.Store(&cert)

	log.Printf("INFO: obtained TLS certificate for %s (expires %s)", m.domain, leaf.NotAfter.Format(time.RFC3339))
	return nil
}
