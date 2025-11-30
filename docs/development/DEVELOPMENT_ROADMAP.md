# Development Roadmap

This document outlines the development roadmap for the `@mcp-abap-adt/auth-broker` package and related authentication infrastructure.

## Current State (v0.1.0)

**Status**: ✅ Released

The current implementation is a monolithic package that provides:
- JWT token management for SAP ABAP ADT systems
- File-based storage (`.env` and `.json` files)
- Browser-based OAuth2 authentication
- Token validation and automatic refresh
- In-memory caching

**Limitations**:
- Direct file system dependencies (`fs`, `path`)
- No abstraction for storage backends
- Single package structure (not modular)
- Limited to file-based storage only
- No support for multiple auth modes (only JWT)

---

## Phase 1: Interface Abstraction (v0.2.0)

**Goal**: Introduce storage interfaces directly in auth-broker without breaking existing API

**Rationale**: Instead of creating a separate `auth-broker-core` package, we add interfaces directly to `auth-broker`. This keeps the core logic (`AuthBroker` class) in the main package while allowing consumers to provide custom storage implementations. The default implementation uses file system, but consumers can inject their own stores (e.g., for database, cloud storage, etc.).

### Tasks

1. **Define Core Interfaces**
   - [ ] Create `ServiceKeyStore` interface in `src/stores/interfaces.ts`
     - `getServiceKey(destination: string): Promise<ServiceKey | null>`
   - [ ] Create `SessionStore` interface in `src/stores/interfaces.ts`
     - `loadSession(destination: string): Promise<EnvConfig | null>`
     - `saveSession(destination: string, config: EnvConfig): Promise<void>`
     - `deleteSession?(destination: string): Promise<void>` (optional)
   - [ ] Export interfaces from `src/stores/interfaces.ts`

2. **Create Default File-Based Implementations**
   - [ ] Create `FileServiceKeyStore` class in `src/stores/FileServiceKeyStore.ts`
     - Implements `ServiceKeyStore`
     - Uses existing `loadServiceKey` logic
     - Supports search paths (constructor parameter or `AUTH_BROKER_PATH` env var)
   - [ ] Create `FileSessionStore` class in `src/stores/FileSessionStore.ts`
     - Implements `SessionStore`
     - Uses existing `loadEnvFile` and `saveTokenToEnv` logic
     - Supports search paths (constructor parameter or `AUTH_BROKER_PATH` env var)
   - [ ] Export default implementations from `src/stores/index.ts`

3. **Refactor AuthBroker**
   - [ ] Update `AuthBroker` constructor to accept optional `ServiceKeyStore` and `SessionStore`
   - [ ] Default to `FileServiceKeyStore` and `FileSessionStore` if not provided
   - [ ] Update `AuthBroker` methods to use injected stores instead of direct file operations
   - [ ] Maintain backward compatibility (searchPaths parameter still works, creates file stores internally)

4. **Update Internal Functions**
   - [ ] Refactor `getToken`, `refreshToken`, `getSapUrl` to accept stores as parameters
   - [ ] Update `AuthBroker` methods to pass stores to internal functions
   - [ ] Keep internal functions for backward compatibility (used by AuthBroker)

5. **Update Documentation**
   - [ ] Document new interfaces
   - [ ] Add examples of custom store implementations
   - [ ] Add migration guide from v0.1.0 to v0.2.0
   - [ ] Update architecture documentation

**Timeline**: 2-3 weeks

**Breaking Changes**: None (backward compatible - default file stores are used if not provided)

**Benefits**:
- No need for separate `auth-broker-core` package
- Core logic stays in main package
- Consumers can inject custom stores without creating new packages
- Future packages (e.g., `auth-broker-redis`, `auth-broker-db`) can provide store implementations

---

## Phase 2: Cache Package (v0.3.0)

**Goal**: Extract caching layer into separate package

### Tasks

1. **Create `@mcp-abap-adt/auth-broker-cache` Package**
   - [ ] Implement `CachingSessionStore` decorator
   - [ ] Implement `CachingServiceKeyStore` decorator (optional)
   - [ ] Support TTL and cache invalidation
   - [ ] Memory-efficient cache implementation

2. **Integration**
   - [ ] Update `auth-broker-fs` to optionally use cache
   - [ ] Document cache usage patterns
   - [ ] Performance benchmarks

**Timeline**: 1-2 weeks

**Breaking Changes**: None

---

## Phase 4: Standard Directory Layout (v0.5.0)

**Goal**: Implement standard directory structure for service keys and sessions

### Tasks

1. **Standard Paths**
   - [ ] Linux/macOS: `~/.config/auth-broker/`
   - [ ] Windows: `%USERPROFILE%\Documents\auth-broker\`
   - [ ] Support `AUTH_BROKER_HOME` override

2. **Directory Structure**
   ```
   ~/.config/auth-broker/
     service-keys/
       *.json
     sessions/
       *.env
   ```

3. **Migration**
   - [ ] Migration utility for existing `.env`/`.json` files
   - [ ] Backward compatibility with old paths
   - [ ] Documentation for migration

**Timeline**: 1-2 weeks

**Breaking Changes**: None (backward compatible with old paths)

---

## Phase 5: MCP HTTP Proxy (v1.0.0)

**Goal**: Create local HTTP proxy for cloud MCP servers

### Tasks

1. **Create `@mcp-abap-adt/mcp-http-proxy` Package**
   - [ ] HTTP server (Express/Fastify)
   - [ ] Request forwarding to cloud MCP
   - [ ] Header injection via `AuthBroker`
   - [ ] HTTPS-only enforcement for remote MCP
   - [ ] CLI tool for starting proxy

2. **Features**
   - [ ] Support `X-Service-Key` and `X-Auth-Mode` headers
   - [ ] Automatic token refresh
   - [ ] Request/response logging (optional)
   - [ ] Health check endpoint

3. **Security**
   - [ ] Validate `remoteMcpUrl` starts with `https://`
   - [ ] No service keys or refresh tokens in proxy
   - [ ] Only access tokens forwarded

4. **CLI**
   ```bash
   mcp-abap-proxy \
     --port 4000 \
     --remote https://mcp-abap-adt.cfapps.eu10.hana.ondemand.com \
     --auth-root ~/.config/auth-broker
   ```

**Timeline**: 3-4 weeks

**Breaking Changes**: New package, no breaking changes to existing packages

---

## Phase 6: Enhanced Authentication Modes (v1.1.0)

**Goal**: Support multiple authentication modes

### Tasks

1. **Auth Mode Support**
   - [ ] JWT mode (current, OAuth2)
   - [ ] Basic Auth mode (username/password from service key)
   - [ ] BTP Destination Forwarding mode

2. **API Changes**
   ```typescript
   await broker.getAuthHeaders('PROFILE', 'jwt');
   await broker.getAuthHeaders('PROFILE', 'basic');
   await broker.getAuthHeaders('PROFILE', 'btp_destination');
   ```

3. **Service Key Extensions**
   - [ ] Support `username`/`password` in service key
   - [ ] Support destination forwarding configuration

**Timeline**: 2-3 weeks

**Breaking Changes**: API extension (backward compatible)

---

## Phase 7: PKCE and Device Flow (v1.2.0)

**Goal**: Enhanced browser authentication flows

### Tasks

1. **PKCE Flow**
   - [ ] Generate code verifier and challenge
   - [ ] PKCE-compliant authorization flow
   - [ ] Token exchange with PKCE parameters

2. **Device Code Flow**
   - [ ] Device code generation
   - [ ] Polling mechanism
   - [ ] User-friendly device code display
   - [ ] Automatic token retrieval

3. **Fallback Strategy**
   - [ ] Try PKCE first
   - [ ] Fallback to device flow if PKCE fails
   - [ ] Configurable flow preference

**Timeline**: 2-3 weeks

**Breaking Changes**: None (enhancement)

---

## Phase 8: Additional Storage Backends (v1.3.0+)

**Goal**: Support alternative storage backends

### Potential Implementations

1. **Redis Storage**
   - [ ] `@mcp-abap-adt/auth-broker-redis`
   - [ ] Redis-based session store
   - [ ] Distributed caching

2. **Database Storage**
   - [ ] `@mcp-abap-adt/auth-broker-sqlite`
   - [ ] SQLite-based storage
   - [ ] Encrypted storage option

3. **Cloud Storage** (Future)
   - [ ] Encrypted cloud storage integration
   - [ ] Multi-device sync

**Timeline**: 2-4 weeks per backend

**Breaking Changes**: None (new packages)

---

## Phase 9: Encryption and Security Enhancements (v1.4.0)

**Goal**: Enhanced security for stored credentials

### Tasks

1. **Session Encryption**
   - [ ] Encrypt refresh tokens at rest
   - [ ] Key derivation from user credentials
   - [ ] Secure key storage

2. **Service Key Protection**
   - [ ] Optional encryption for service keys
   - [ ] Keychain integration (macOS/Windows)

3. **Audit Logging**
   - [ ] Log authentication events
   - [ ] Token refresh tracking
   - [ ] Security event monitoring

**Timeline**: 3-4 weeks

**Breaking Changes**: Optional (opt-in encryption)

---

## Phase 10: Multi-Agent Support and Tooling (v2.0.0)

**Goal**: Universal authentication for all MCP agents

### Tasks

1. **Agent Integration**
   - [ ] Cline integration guide
   - [ ] GitHub Copilot integration
   - [ ] VSCode extension support
   - [ ] CLI tool improvements

2. **Developer Tools**
   - [ ] `auth-broker-cli` package
   - [ ] Interactive setup wizard
   - [ ] Service key validation tool
   - [ ] Token inspection utilities

3. **Documentation**
   - [ ] Agent-specific setup guides
   - [ ] Troubleshooting guides
   - [ ] Best practices documentation

**Timeline**: 4-6 weeks

**Breaking Changes**: None (new tooling)

---

## Package Dependency Graph (Target State)

```
auth-broker-core (zero deps)
    ↑
    ├── auth-broker-fs (depends on core)
    ├── auth-broker-cache (depends on core)
    ├── auth-broker-redis (depends on core) [future]
    └── auth-broker-sqlite (depends on core) [future]

mcp-http-proxy (depends on core + fs + cache)
local MCP server (depends on core + fs + cache)
```

---

## Migration Strategy

### From v0.1.0 to v0.2.0
- No changes required (backward compatible)
- Optional: Start using interfaces for custom stores

### From v0.2.0 to v0.3.0
- Update package name: `@mcp-abap-adt/auth-broker-fs`
- Or use re-exported `AuthBroker` from main package
- Core package available for custom implementations

### From v0.3.0 to v0.4.0+
- Gradual adoption of new features
- All changes backward compatible
- Migration guides provided for each phase

---

## Success Metrics

- **Modularity**: Zero-dependency core package
- **Extensibility**: At least 3 storage backend implementations
- **Security**: No secrets in cloud MCP
- **Adoption**: Support for all major MCP agents
- **Performance**: <100ms token retrieval (cached)
- **Developer Experience**: Simple setup, clear documentation

---

## Contributing

Contributions are welcome! Please see [CONTRIBUTORS.md](CONTRIBUTORS.md) for guidelines.

For questions or discussions about the roadmap, please open an issue on GitHub.

---

**Last Updated**: 2025-01-XX

**Current Version**: v0.1.0

**Next Milestone**: v0.2.0 (Interface Abstraction)

