Throwaway test material for the `mcp-auth --client-auth certificate` tests:
a self-signed server certificate for `127.0.0.1` (`server.crt`, `server.key`),
trusted only inside the test process, and a self-signed client certificate
(`client.crt`, `client.key`). Trusted by nothing else; never use it anywhere
else. Made with:

    openssl req -x509 -newkey rsa:2048 -nodes -keyout server.key -out server.crt \
      -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" -days 36500
    openssl req -x509 -newkey rsa:2048 -nodes -keyout client.key -out client.crt \
      -subj "/CN=mcp-auth-test-client" -days 36500
