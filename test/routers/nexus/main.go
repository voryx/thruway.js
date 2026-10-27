// nexus-test: a gammazero/nexus WAMP router for thruway.js v3 integration/fuzz tests.
//
// Stock nexusd can only do anonymous auth from its JSON config, so this tiny main
// embeds the nexus router library and adds ticket, wampcra (plain and PBKDF2-salted)
// and cryptosign authenticators backed by a static user list.
//
// Realms are decoded from JSON straight into router.RealmConfig, so any option the
// linked nexus version knows (e.g. "strict_request_ids" on master after v3.3.1) can be
// set from the config file; options an older version does not know are ignored and
// reported at startup.
package main

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"reflect"
	"syscall"
	"time"

	"github.com/gammazero/nexus/v3/router"
	"github.com/gammazero/nexus/v3/router/auth"
)

type userConfig struct {
	AuthID     string `json:"authid"`
	Role       string `json:"role"`
	Ticket     string `json:"ticket"`
	CRASecret  string `json:"wampcra_secret"`
	Salt       string `json:"salt"`
	Iterations int    `json:"iterations"`
	KeyLen     int    `json:"keylen"`
	PubKey     string `json:"cryptosign_pubkey"`
}

type fileConfig struct {
	WebsocketAddress string            `json:"websocket_address"`
	RawsocketTCP     string            `json:"rawsocket_tcp_address"`
	Debug            bool              `json:"debug"`
	AuthTimeoutSec   int               `json:"auth_timeout_sec"`
	Realms           []json.RawMessage `json:"realms"`
	Users            []userConfig      `json:"users"`
}

type keyStore struct{ users map[string]userConfig }

func (ks *keyStore) AuthKey(authid, authmethod string) ([]byte, error) {
	u, ok := ks.users[authid]
	if !ok {
		return nil, errors.New("no such user")
	}
	switch authmethod {
	case "ticket":
		if u.Ticket != "" {
			return []byte(u.Ticket), nil
		}
	case "wampcra":
		if u.CRASecret == "" {
			break
		}
		if u.Salt == "" {
			return []byte(u.CRASecret), nil
		}
		// Same derivation as autobahn's derive_key: base64(PBKDF2-HMAC-SHA256(secret, salt)).
		dk, err := pbkdf2.Key(sha256.New, u.CRASecret, []byte(u.Salt), u.Iterations, u.KeyLen)
		if err != nil {
			return nil, err
		}
		return []byte(base64.StdEncoding.EncodeToString(dk)), nil
	case "cryptosign":
		if u.PubKey != "" {
			return hex.DecodeString(u.PubKey)
		}
	}
	return nil, fmt.Errorf("user %q has no %s key", authid, authmethod)
}

func (ks *keyStore) PasswordInfo(authid string) (string, int, int) {
	u := ks.users[authid]
	return u.Salt, u.KeyLen, u.Iterations
}

func (ks *keyStore) AuthRole(authid string) (string, error) {
	u, ok := ks.users[authid]
	if !ok {
		return "", errors.New("no such user")
	}
	return u.Role, nil
}

func (ks *keyStore) Provider() string { return "thruway-test-keystore" }

// knownJSONKeys lists the json keys router.RealmConfig accepts in the linked nexus version.
func knownJSONKeys() map[string]bool {
	keys := map[string]bool{"uri": true, "thruway_auth": true}
	t := reflect.TypeOf(router.RealmConfig{})
	for i := 0; i < t.NumField(); i++ {
		if tag := t.Field(i).Tag.Get("json"); tag != "" && tag != "-" {
			keys[tag] = true
		}
	}
	return keys
}

func main() {
	cfgPath := flag.String("c", "/etc/nexus-test.json", "config file")
	flag.Parse()

	data, err := os.ReadFile(*cfgPath)
	if err != nil {
		log.Fatal(err)
	}
	var fc fileConfig
	if err = json.Unmarshal(data, &fc); err != nil {
		log.Fatal("config: ", err)
	}
	if fc.AuthTimeoutSec == 0 {
		fc.AuthTimeoutSec = 5
	}
	ks := &keyStore{users: map[string]userConfig{}}
	for _, u := range fc.Users {
		ks.users[u.AuthID] = u
	}
	timeout := time.Duration(fc.AuthTimeoutSec) * time.Second

	known := knownJSONKeys()
	rc := &router.Config{Debug: fc.Debug}
	for _, raw := range fc.Realms {
		var realm router.RealmConfig
		if err = json.Unmarshal(raw, &realm); err != nil {
			log.Fatal("realm config: ", err)
		}
		var extra map[string]any
		_ = json.Unmarshal(raw, &extra)
		for k := range extra {
			if !known[k] {
				log.Printf("WARNING realm %s: option %q is not supported by nexus %s (ignored)", realm.URI, k, router.Version)
			}
		}
		if on, _ := extra["thruway_auth"].(bool); on {
			realm.Authenticators = []auth.Authenticator{
				auth.NewTicketAuthenticator(ks, timeout),
				auth.NewCRAuthenticator(ks, timeout),
				auth.NewCryptoSignAuthenticator(ks, timeout),
			}
		}
		log.Printf("realm %s (authenticators=%d): %s", realm.URI, len(realm.Authenticators), raw)
		rc.RealmConfigs = append(rc.RealmConfigs, &realm)
	}

	nxr, err := router.NewRouter(rc, log.New(os.Stdout, "", log.LstdFlags))
	if err != nil {
		log.Fatal(err)
	}
	defer nxr.Close()

	wss := router.NewWebsocketServer(nxr)
	wss.Upgrader.EnableCompression = true
	if err = wss.AllowOrigins([]string{"*"}); err != nil { // browsers send Origin; accept any
		log.Fatal(err)
	}
	wss.KeepAlive = 30 * time.Second
	wsCloser, err := wss.ListenAndServe(fc.WebsocketAddress)
	if err != nil {
		log.Fatal(err)
	}
	defer wsCloser.Close() //nolint:errcheck
	log.Printf("nexus %s: websocket listening on %s", router.Version, fc.WebsocketAddress)

	if fc.RawsocketTCP != "" {
		rss := router.NewRawSocketServer(nxr)
		tcpCloser, err := rss.ListenAndServe("tcp", fc.RawsocketTCP)
		if err != nil {
			log.Fatal(err)
		}
		defer tcpCloser.Close() //nolint:errcheck
		log.Printf("nexus %s: rawsocket listening on tcp %s", router.Version, fc.RawsocketTCP)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Print("shutting down")
}
