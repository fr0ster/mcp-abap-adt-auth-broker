# Documentation

Complete documentation for the `@mcp-abap-adt/auth-broker` package.

## Quick Start

- [Main README](../README.md) - Package overview, installation, and quick start guide
- [Installation Guide](installing/INSTALLATION.md) - How to install and set up the package
- [Usage Guide](using/USAGE.md) - API documentation and usage examples

## Documentation Structure

```
docs/
├── README.md                    # This file - documentation index
├── architecture/
│   └── ARCHITECTURE.md         # System architecture and design
├── development/
│   └── TESTING.md              # Testing methodology and guide
├── installing/
│   └── INSTALLATION.md         # Installation and setup guide
└── using/
    └── USAGE.md                # API reference and usage examples
```

## Sections

### [Architecture](architecture/ARCHITECTURE.md)
Technical documentation about the system architecture, design decisions, and internal structure:
- Component overview
- Authentication flow
- Token management
- File system structure
- Search path resolution

### [Development](development/TESTING.md)
Documentation for developers:
- Testing methodology
- Test structure and organization
- Running tests
- Test scenarios
- Debugging

### [Installing](installing/INSTALLATION.md)
Installation and setup guide:
- Prerequisites
- NPM installation
- Configuration
- Environment setup

### [Using](using/USAGE.md)
API reference and usage examples:
- Basic usage
- API methods
- Configuration options
- Examples
- Error handling

## Key Concepts

### AuthBroker Class

The main class for managing JWT authentication tokens:
- **getToken()** - Get token for destination (loads, validates, refreshes if needed)
- **refreshToken()** - Force refresh token using service key
- **clearCache()** - Clear cached token for specific destination
- **clearAllCache()** - Clear all cached tokens

### File-Based Configuration

The package uses file-based configuration:
- **{destination}.env** - Environment file with tokens and connection parameters
- **{destination}.json** - Service key file for OAuth authentication

### Multi-Path Search

Files are searched in multiple paths with priority:
1. Constructor parameter (highest priority)
2. `AUTH_BROKER_PATH` environment variable
3. Current working directory (lowest priority)

