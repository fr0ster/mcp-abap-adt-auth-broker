# Migration Guide: v0.1.x → v0.2.0

This guide helps you migrate from `@mcp-abap-adt/auth-broker` v0.1.x to v0.2.0.

**⚠️ IMPORTANT: This is a breaking change with NO backward compatibility. The old constructor signature is NOT supported. You must update your code.**

## Overview of Changes

### Breaking Changes

1. **Constructor Signature**: `serviceKeyStore` and `tokenProvider` are now optional. **Old constructor signature is NOT supported - migration is required.**
2. **New Authentication Flow**: Three-step flow (Step 0, Step 1, Step 2) instead of six-step fallback chain
3. **Direct UAA HTTP Requests**: Broker now uses direct HTTP requests to UAA when UAA credentials are available
4. **Session Requirements**: SessionStore must contain initial session with `serviceUrl` before calling `getToken()`

## Migration Steps

### Step 1: Update Constructor Calls

#### Before (v0.1.x)

```typescript
import { AuthBroker, AbapServiceKeyStore, AbapSessionStore, BtpTokenProvider } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path/to/destinations']),
  sessionStore: new AbapSessionStore(['/path/to/destinations']),
  tokenProvider: new BtpTokenProvider(),
}, 'chrome', logger);
```

#### After (v0.2.0) - All Dependencies

```typescript
import { AuthBroker, AbapServiceKeyStore, AbapSessionStore, BtpTokenProvider } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/destinations'), // optional
  tokenProvider: new BtpTokenProvider(), // optional
}, 'chrome', logger);
```

**Note**: Store constructors now accept a single `directory` string instead of an array of paths.

### Step 2: Choose Your Configuration Mode

#### Option A: Session Only (Recommended if session has UAA credentials)

If your session already contains valid UAA credentials, you only need `sessionStore`:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  // serviceKeyStore and tokenProvider not needed
});

// Direct UAA HTTP requests will be used automatically
const token = await broker.getToken('TRIAL');
```

**Benefits:**
- Simpler configuration
- No dependency on service keys or providers
- Faster token refresh (direct HTTP requests)

**Requirements:**
- Session must contain `serviceUrl` (required)
- Session should contain UAA credentials (`uaaUrl`, `uaaClientId`, `uaaClientSecret`) for direct UAA requests

#### Option B: Session + Service Key (For Initialization)

If you need to initialize sessions from service keys:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/destinations'),
  // tokenProvider optional - direct UAA requests will be used from service key
});
```

**Use Case:**
- Initializing empty sessions from service keys (Step 0)
- Direct UAA requests will be used if service key contains UAA credentials

#### Option C: Full Configuration (Maximum Flexibility)

For maximum flexibility, provide all three dependencies:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/destinations'),
  tokenProvider: new BtpTokenProvider(), // for browser auth or fallback
}, 'chrome', logger);
```

**Use Case:**
- Browser authentication when initializing from service key
- Fallback when direct UAA requests fail

### Step 3: Ensure Session Has serviceUrl

**Important**: SessionStore must contain initial session with `serviceUrl` before calling `getToken()`.

#### If Session is Empty

You must provide `serviceKeyStore` to initialize from service key:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
  serviceKeyStore: new AbapServiceKeyStore('/path/to/destinations'),
  // tokenProvider optional - direct UAA requests will be used
});

// This will initialize session from service key (Step 0)
const token = await broker.getToken('TRIAL');
```

#### If Session Already Has serviceUrl

You can use session-only mode:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path/to/destinations'),
});

// Works if session has serviceUrl and UAA credentials
const token = await broker.getToken('TRIAL');
```

### Step 4: Update Store Constructor Calls

Store constructors now accept a single `directory` string instead of an array:

#### Before (v0.1.x)

```typescript
new AbapSessionStore(['/path/to/destinations'])
new AbapServiceKeyStore(['/path/to/destinations'])
```

#### After (v0.2.0)

```typescript
new AbapSessionStore('/path/to/destinations')
new AbapServiceKeyStore('/path/to/destinations')
```

### Step 5: Understand New Authentication Flow

The authentication flow has changed from a six-step fallback chain to a three-step flow:

#### Old Flow (v0.1.x)
1. Check session
2. Check service key
3. Try refresh token
4. Try UAA (client_credentials)
5. Try browser authentication
6. Throw error

#### New Flow (v0.2.0)
- **Step 0**: Initialize session from service key (if needed)
- **Step 1**: Refresh token flow (direct UAA or provider)
- **Step 2**: UAA credentials flow (direct UAA or provider)

**Key Differences:**
- Direct UAA HTTP requests are used when UAA credentials are available
- Provider is only used for browser auth or as fallback
- Simpler, more efficient flow

## Common Migration Scenarios

### Scenario 1: Session Already Has UAA Credentials

**Before:**
```typescript
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path']),
  sessionStore: new AbapSessionStore(['/path']),
  tokenProvider: new BtpTokenProvider(),
});
```

**After:**
```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path'),
  // serviceKeyStore and tokenProvider not needed
});
```

### Scenario 2: Need to Initialize from Service Key

**Before:**
```typescript
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path']),
  sessionStore: new AbapSessionStore(['/path']),
  tokenProvider: new BtpTokenProvider(),
});
```

**After:**
```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path'),
  serviceKeyStore: new AbapServiceKeyStore('/path'),
  // tokenProvider optional - direct UAA requests will be used
});
```

### Scenario 3: Need Browser Authentication

**Before:**
```typescript
const broker = new AuthBroker({
  serviceKeyStore: new AbapServiceKeyStore(['/path']),
  sessionStore: new AbapSessionStore(['/path']),
  tokenProvider: new BtpTokenProvider(),
}, 'chrome');
```

**After:**
```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path'),
  serviceKeyStore: new AbapServiceKeyStore('/path'),
  tokenProvider: new BtpTokenProvider(), // needed for browser auth
}, 'chrome');
```

## Error Handling

### New Error Messages

Error messages now indicate which step failed:

- `Step 0: Cannot initialize session...` - Session initialization failed
- `Step 1: Refresh token flow failed...` - Refresh token failed
- `Step 2: UAA credentials not found...` - UAA credentials missing

### Common Errors

#### Error: "Session is missing required field 'serviceUrl'"

**Solution**: Ensure sessionStore contains initial session with `serviceUrl`:

```typescript
// Create session with serviceUrl first
await sessionStore.setConnectionConfig('TRIAL', {
  serviceUrl: 'https://example.com',
});

// Then use broker
const broker = new AuthBroker({ sessionStore });
const token = await broker.getToken('TRIAL');
```

#### Error: "Cannot initialize session: serviceKeyStore is not available"

**Solution**: Provide `serviceKeyStore` to initialize from service key:

```typescript
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path'),
  serviceKeyStore: new AbapServiceKeyStore('/path'), // add this
});
```

#### Error: "UAA credentials incomplete and tokenProvider not available"

**Solution**: Either provide UAA credentials in session or provide `tokenProvider`:

```typescript
// Option 1: Add UAA credentials to session
await sessionStore.setAuthorizationConfig('TRIAL', {
  uaaUrl: 'https://uaa.example.com',
  uaaClientId: 'client-id',
  uaaClientSecret: 'client-secret',
});

// Option 2: Provide tokenProvider
const broker = new AuthBroker({
  sessionStore: new AbapSessionStore('/path'),
  tokenProvider: new BtpTokenProvider(), // add this
});
```

## Testing Your Migration

1. **Test Session-Only Mode**:
   ```typescript
   const broker = new AuthBroker({
     sessionStore: new AbapSessionStore('/path'),
   });
   const token = await broker.getToken('TRIAL');
   ```

2. **Test Service Key Initialization**:
   ```typescript
   const broker = new AuthBroker({
     sessionStore: new AbapSessionStore('/path'),
     serviceKeyStore: new AbapServiceKeyStore('/path'),
   });
   const token = await broker.getToken('TRIAL'); // should initialize from service key
   ```

3. **Test Provider Fallback**:
   ```typescript
   const broker = new AuthBroker({
     sessionStore: new AbapSessionStore('/path'),
     serviceKeyStore: new AbapServiceKeyStore('/path'),
     tokenProvider: new BtpTokenProvider(),
   });
   const token = await broker.getToken('TRIAL');
   ```

## Benefits of v0.2.0

1. **Simpler Configuration**: Can work with only `sessionStore` if session has UAA credentials
2. **Faster Token Refresh**: Direct UAA HTTP requests are faster than going through provider
3. **More Flexible**: Choose the configuration that fits your needs
4. **Better Error Messages**: Step-based error messages help identify issues quickly

## Need Help?

If you encounter issues during migration:

1. Check error messages - they now indicate which step failed
2. Ensure session has `serviceUrl` before calling `getToken()`
3. Verify UAA credentials are in session if using session-only mode
4. Check CHANGELOG.md for detailed change descriptions
