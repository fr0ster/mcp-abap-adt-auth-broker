Throwaway test material for the client-authentication tests: a self-signed
client certificate (`client.crt`) and its unencrypted key (`client.key`).
Trusted by nothing; never use it anywhere else. Made with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout client.key -out client.crt \
      -subj "/CN=broker-test-client" -days 36500

`expired.crt` / `expired.key`: a self-signed certificate valid only on
2020-01-01, for the expired-certificate refusal. Made with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout expired.key -out expired.crt \
      -subj "/CN=broker-test-expired" -not_before 20200101000000Z -not_after 20200102000000Z
