# TLS test fixture

`self-signed.key` / `self-signed.crt`: a self-signed P-256 certificate for `CN=127.0.0.1`
(SAN `IP:127.0.0.1`, `DNS:localhost`), valid for 100 years. It is **not** trusted by anything; the
TLS-failure cases of `test/node/websocket-real.test.ts` use it to get an "untrusted
certificate" failure that is not a hostname mismatch. The private key protects nothing.

Generated once (OpenSSL 3.6.5):

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout self-signed.key -out self-signed.crt -days 36500 -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=serverAuth"
```
