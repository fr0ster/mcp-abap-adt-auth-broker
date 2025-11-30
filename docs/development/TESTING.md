# Testing Methodology

This document describes the testing methodology, test structure, and how to run tests for the `@mcp-abap-adt/auth-broker` package.

## Test Structure

Tests are located in `src/__tests__/` and organized by functionality:

```
src/__tests__/
├── AuthBroker.test.ts          # Basic AuthBroker class tests
├── getToken.test.ts            # getToken() method tests
├── refreshToken.test.ts        # refreshToken() method tests
├── envLoader.test.ts           # Environment loader unit tests
├── serviceKeyLoader.test.ts    # Service key loader unit tests
└── pathResolver.test.ts        # Path resolver unit tests
```

## Test Configuration

### Jest Configuration

Tests use Jest with the following configuration (`jest.config.js`):

- **Sequential Execution**: `maxWorkers: 1` and `maxConcurrency: 1` ensure tests run one by one
- **TypeScript Support**: Uses `ts-jest` preset
- **ES Module Support**: Handles ES modules (e.g., `open` package) via dynamic imports
- **Test Timeout**: 5 minutes for browser authentication tests

### Test Environment

Tests require:
- Node.js >= 18.0.0
- Service key file: `./test-destinations/TRIAL.json`
- Optional: `TEST_DESTINATIONS_PATH` environment variable to specify custom path

## Test Scenarios

### getToken.test.ts

Three main test scenarios:

#### Test 1: Destination that does not exist
- **Purpose**: Verify error handling for non-existent destination
- **Requirements**: `NO_EXISTS.json` should NOT exist
- **Expected**: Error message with instructions on where to place files
- **Status**: ✅ Always runs (no external dependencies)

#### Test 2: Service key exists but no .env file
- **Purpose**: Test browser authentication flow
- **Requirements**: 
  - `TRIAL.json` must exist in `./test-destinations/`
  - `TRIAL.env` should NOT exist (will be removed if exists)
- **Expected**: 
  - Browser opens for OAuth authentication
  - User completes authentication
  - `TRIAL.env` file is created with tokens
- **Status**: ⚠️ Requires user interaction (browser authentication)
- **Timeout**: 5 minutes

#### Test 3: .env file exists - token refresh
- **Purpose**: Test token retrieval/refresh from existing .env file
- **Requirements**: 
  - `TRIAL.json` must exist
  - `TRIAL.env` must exist (can be created by Test 2 or manually)
- **Expected**: 
  - Token is retrieved from .env
  - If expired, token is refreshed
  - .env file is updated with new token
- **Status**: ✅ Can run independently if .env exists

### refreshToken.test.ts

Similar structure to `getToken.test.ts` but tests `refreshToken()` method:

#### Test 1: Destination that does not exist
- Same as getToken Test 1

#### Test 2: Service key exists but no .env file
- Same as getToken Test 2 (browser authentication)

#### Test 3: .env file exists - token refresh
- Tests refresh using refresh token from .env

#### Error Cases
- Invalid service key (missing UAA fields)
- Missing SAP URL in service key

## Running Tests

### Run All Tests

```bash
npm test
```

### Run Specific Test File

```bash
# Run all tests in getToken.test.ts (Test 1, 2, 3 sequentially)
npm test -- getToken.test.ts

# Run all tests in refreshToken.test.ts
npm test -- refreshToken.test.ts
```

### Run Specific Test

```bash
# Run only Test 1
npm test -- getToken.test.ts -t "Test 1"

# Run only Test 2 (requires Test 1 to pass first)
npm test -- getToken.test.ts -t "Test 2"

# Run only Test 3
npm test -- getToken.test.ts -t "Test 3"
```

### Run Unit Tests Only

```bash
# Run unit tests (no browser interaction required)
npm test -- pathResolver.test.ts
npm test -- envLoader.test.ts
npm test -- serviceKeyLoader.test.ts
npm test -- AuthBroker.test.ts
```

## Test Execution Order

Tests are designed to run sequentially:

1. **Test 1** must pass before Test 2 can run (`test1Passed` flag)
2. **Test 2** creates `TRIAL.env` file needed for Test 3
3. **Test 3** can run independently if `TRIAL.env` exists

### Sequential Execution Guarantee

Jest configuration ensures sequential execution:
- `maxWorkers: 1` - Only one worker process
- `maxConcurrency: 1` - Only one test at a time

This guarantees:
- Tests run in the order they are defined
- No race conditions between tests
- File state is predictable between tests

## Test Setup Requirements

### Before Running Tests

1. **Place Service Key**: Copy your service key to `./test-destinations/TRIAL.json`
   ```bash
   cp /path/to/your/service-key.json ./test-destinations/TRIAL.json
   ```

2. **Ensure Clean State**: 
   - `TRIAL.env` will be automatically removed before Test 2
   - `NO_EXISTS.json` should not exist (for Test 1)

3. **Optional**: Set custom test destinations path
   ```bash
   export TEST_DESTINATIONS_PATH=/custom/path
   ```

### Test File Management

- **Before Test 1**: `NO_EXISTS.json` should NOT exist
- **Before Test 2**: `TRIAL.env` is automatically removed if exists
- **After Test 2**: `TRIAL.env` is created (not deleted)
- **Before Test 3**: `TRIAL.env` must exist (created by Test 2 or manually)

## Test Methodology

### Integration Tests (getToken.test.ts, refreshToken.test.ts)

These tests use **real implementations** without mocks:
- ✅ Real file system operations
- ✅ Real HTTP requests (token validation, refresh)
- ✅ Real browser authentication (Test 2)
- ✅ Real service key files

**Why no mocks?**
- Tests real-world scenarios
- Validates actual integration with SAP systems
- Catches issues that mocks might miss

### Test Output

Tests are designed to be **silent by default**:
- No verbose logging during test execution
- Only test results and errors are shown
- Clean, focused output that highlights failures
- No informational messages about expected test flow

This approach ensures:
- **Clear visibility** when tests fail (no noise from passing tests)
- **Fast feedback** - only important information is displayed
- **Better CI/CD integration** - minimal output in automated pipelines

### Unit Tests (pathResolver.test.ts, envLoader.test.ts, etc.)

These tests focus on individual components:
- Test specific functions in isolation
- Use temporary directories for file operations
- Clean up after each test

## Test Scenarios Coverage

### ✅ Covered Scenarios

1. **Error Handling**
   - Non-existent destination
   - Missing service key
   - Missing .env file
   - Invalid service key structure

2. **Browser Authentication**
   - OAuth flow initiation
   - Token acquisition
   - .env file creation

3. **Token Management**
   - Token retrieval from .env
   - Token validation
   - Token refresh
   - Cache management

### ⚠️ Edge Cases (Not Explicitly Tested)

These scenarios are covered implicitly or would require complex setup:

1. **Valid Token in Cache** - Covered implicitly (if token is valid, it's returned from cache)
2. **Valid Token in .env** - Covered implicitly (if token is valid, it's returned without refresh)
3. **Multi-Path Search** - Would require complex directory setup
4. **Expired Refresh Token** - Would require expired refresh token (triggers browser auth)
5. **Token Validation Network Errors** - Would require network mocking
6. **Different Service Key Structures** - Partially covered in error cases

## Debugging Tests

### Enable Debug Logging

To see detailed authentication flow during tests:

```bash
DEBUG_AUTH_LOG=true npm test
```

This will show:
- Browser authentication flow details
- Token refresh operations
- Debug messages from AuthBroker

### Enable Verbose Jest Output

Jest is configured with `verbose: true` by default, showing:
- Test names
- Console output
- Error details

### Check Test State

If tests fail or skip unexpectedly:

1. **Check File Existence**:
   ```bash
   ls -la ./test-destinations/
   ```

2. **Check Test Output**: Look for skip messages in console

3. **Verify Service Key**: Ensure `TRIAL.json` is valid JSON with required fields

4. **Check .env File**: If Test 3 fails, verify `TRIAL.env` exists and has valid tokens

### Common Issues

#### Test 2 Skips
- **Cause**: `test1Passed = false` (Test 1 didn't run or failed)
- **Solution**: Run all tests together: `npm test -- getToken.test.ts`

#### Browser Doesn't Open
- **Cause**: ES module import issue or system browser configuration
- **Solution**: Check console for error messages, verify `open` package is installed

#### Test 3 Skips
- **Cause**: `TRIAL.env` doesn't exist
- **Solution**: Run Test 2 first to create it, or create manually

## Best Practices

1. **Run Tests Sequentially**: Always run test files completely to ensure proper order
2. **Clean State**: Tests handle cleanup automatically, but ensure no conflicting files
3. **Service Key Security**: Never commit service keys to version control
4. **Test Isolation**: Each test file uses its own temporary directories
5. **Real Scenarios**: Tests use real implementations to catch integration issues

## Continuous Integration

For CI/CD pipelines:

1. **Skip Browser Tests**: Test 2 requires user interaction - skip in CI
   ```bash
   npm test -- getToken.test.ts -t "Test 1|Test 3"
   ```

2. **Use Test Service Keys**: Use dedicated test service keys (not production)

3. **Timeout Configuration**: Ensure CI has sufficient timeout for tests (5+ minutes)

4. **Environment Variables**: Set `TEST_DESTINATIONS_PATH` if needed

