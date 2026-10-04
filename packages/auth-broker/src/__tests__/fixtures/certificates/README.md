Throwaway test material for the client-authentication tests: a self-signed
client certificate (`client.crt`) and its unencrypted key (`client.key`).
Trusted by nothing; never use it anywhere else. Made with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout client.key -out client.crt \
      -subj "/CN=broker-test-client" -days 36500
