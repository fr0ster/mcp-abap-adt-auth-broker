# Installation Guide

This guide explains how to install and set up the `@mcp-abap-adt/auth-broker` package.

## Prerequisites

- **Node.js**: Version 18.0.0 or higher
- **npm**: Version 7.0.0 or higher (comes with Node.js)
- **SAP BTP Account**: For obtaining service keys (if using browser authentication)

## Installation

### NPM Installation

```bash
npm install @mcp-abap-adt/auth-broker
```

### Verify Installation

```bash
npm list @mcp-abap-adt/auth-broker
```

## Configuration

### Service Key Setup

1. **Obtain Service Key**: Get service key from SAP BTP Cockpit for your ABAP system
2. **Save Service Key**: Save as `{destination}.json` file

Example: `TRIAL.json`
```json
{
  "url": "https://your-system.abap.us10.hana.ondemand.com",
  "uaa": {
    "url": "https://your-account.authentication.us10.hana.ondemand.com",
    "clientid": "your_client_id",
    "clientsecret": "your_client_secret"
  }
}
```

### Environment File Setup

The package automatically creates `{destination}.env` files after authentication. You can also create them manually:

Example: `TRIAL.env`
```env
SAP_URL=https://your-system.abap.us10.hana.ondemand.com
SAP_CLIENT=100
SAP_AUTH_TYPE=jwt
SAP_JWT_TOKEN=your_jwt_token
SAP_REFRESH_TOKEN=your_refresh_token
SAP_UAA_URL=https://your-account.authentication.us10.hana.ondemand.com
SAP_UAA_CLIENT_ID=your_client_id
SAP_UAA_CLIENT_SECRET=your_client_secret
```

## File Locations

### Default Locations

By default, files are searched in the current working directory:
- `{destination}.env` - Environment file with tokens
- `{destination}.json` - Service key file

### Custom Locations

You can specify custom search paths:

**Option 1: Constructor Parameter**
```typescript
import { AuthBroker } from '@mcp-abap-adt/auth-broker';

const broker = new AuthBroker(['/path/to/destinations', '/another/path']);
```

**Option 2: Environment Variable**
```bash
export AUTH_BROKER_PATH=/path/to/destinations:/another/path
```

**Option 3: Multiple Paths**
```bash
# Linux/macOS
export AUTH_BROKER_PATH=/path1:/path2:/path3

# Windows
set AUTH_BROKER_PATH=C:\path1;C:\path2;C:\path3
```

## Search Path Priority

Files are searched in the following order (highest to lowest priority):

1. Constructor parameter paths
2. `AUTH_BROKER_PATH` environment variable paths
3. Current working directory

## Quick Start

1. **Install Package**:
   ```bash
   npm install @mcp-abap-adt/auth-broker
   ```

2. **Create Service Key File**:
   ```bash
   # Save your service key as TRIAL.json
   cp /path/to/service-key.json ./TRIAL.json
   ```

3. **Use in Code**:
   ```typescript
   import { AuthBroker } from '@mcp-abap-adt/auth-broker';

   const broker = new AuthBroker();
   const token = await broker.getToken('TRIAL');
   ```

4. **First Run**: On first run, browser will open for authentication. After authentication, `TRIAL.env` will be created automatically.

## Security Considerations

### File Permissions

Ensure proper file permissions for sensitive files:

```bash
# Linux/macOS
chmod 600 TRIAL.json TRIAL.env

# Windows
icacls TRIAL.json /grant:r %USERNAME%:R
icacls TRIAL.env /grant:r %USERNAME%:R
```

### Version Control

**Never commit** the following files to version control:
- `*.env` files (contain tokens)
- `*.json` service key files (contain credentials)

Add to `.gitignore`:
```
*.env
*.json
!package.json
!package-lock.json
```

### Environment Variables

If using `AUTH_BROKER_PATH`, ensure it's set securely:
- Don't expose in logs
- Use environment-specific values
- Rotate service keys regularly

## Troubleshooting

### File Not Found Errors

If you see "file not found" errors:

1. **Check File Location**: Verify files are in the expected directory
2. **Check Search Paths**: Review constructor parameters and `AUTH_BROKER_PATH`
3. **Check File Names**: Ensure files are named `{destination}.env` and `{destination}.json`

### Browser Authentication Issues

If browser doesn't open:

1. **Check System Browser**: Verify default browser is configured
2. **Check Port 3001**: Ensure port 3001 is available for OAuth callback
3. **Check Firewall**: Ensure localhost connections are allowed

### Token Refresh Issues

If token refresh fails:

1. **Check Refresh Token**: Verify refresh token is valid and not expired
2. **Check UAA Credentials**: Ensure service key has correct UAA configuration
3. **Check Network**: Verify connectivity to UAA server

## Next Steps

- See [Usage Guide](../using/USAGE.md) for API documentation and examples
- See [Architecture](../architecture/ARCHITECTURE.md) for technical details
- See [Testing](../development/TESTING.md) for development and testing guide

