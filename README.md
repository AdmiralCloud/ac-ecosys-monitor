# Server Monitoring Dashboard

A real-time monitoring tool built with Node.js that checks server availability via ping and API calls, displaying results in a beautiful refreshing table format.

## Features

- **Ping Monitoring**: Check server availability using ICMP ping
- **API Monitoring**: Monitor HTTP/HTTPS endpoints and verify status codes
- **Response Validation**: Optional field checking in JSON responses using dot notation
- **Unified Checks**: Combine ping + API monitoring in a single line display
- **Configurable Refresh Rate**: Set your own monitoring interval (default: 1 minute)
- **Color-coded Status**: Easy-to-read table with color-coded results
- **Cross-platform**: Works on Linux, macOS, and Windows
- **Graceful Shutdown**: Press Ctrl+C to exit cleanly

## Status Types

The dashboard now shows four possible states:

- **UP** (✓ green) - Everything is working (ping + API + health checks)
- **UNHEALTHY** (⚠ yellow) - Server responding but health checks fail (internal service down)
- **DEGRADED** (⚠ yellow) - Partial connectivity (network issue detected)
- **DOWN** (✗ red) - Server unreachable or wrong HTTP status code
- **ERROR** (⚠ red) - Other errors (timeout, network issues)

## Installation

### Prerequisites
- Node.js 12.0.0 or higher
- npm (comes with Node.js)

### Setup

1. Clone or download the files:
   - `server-monitor.js` (main script)
   - `config/index.js` (configuration file)
   - `package.json` (dependencies)
   - `yarn.lock` (dependencies lock file — do not edit manually)

2. Install dependencies:
```bash
yarn install
```
## Quick Start

1. Create `config/env/local.js` to add your servers
2. Run the monitor:
```bash
yarn start
```

or directly with Node:
```bash
node server-monitor.js
```

## Configuration

Edit `config/env/local.js` to customize your monitoring:

### Basic Settings

```javascript
module.exports = {
  // Refresh interval in milliseconds (60000 = 1 minute)
  refreshInterval: 60000,
  
  servers: [
    // Your server definitions here
  ]
};
```

### Server Definition Examples

#### Ping a Server
```javascript
{
  name: 'Production Web Server',
  type: 'ping',
  target: '192.168.1.100',
  timeout: 5000  // milliseconds
}
```

#### Monitor an API Endpoint
```javascript
{
  name: 'API Gateway',
  type: 'api',
  target: 'https://api.example.com/health',
  timeout: 10000,
  expectedStatus: 200
}
```

## Configuration Options

### Server Object Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | string | ✓ | Display name for the server |
| `type` | string | ✓ | Either `'ping'` or `'api'` |
| `target` | string | ✓ | IP address (for ping) or URL (for API) |
| `timeout` | number | ✓ | Timeout in milliseconds |
| `expectedStatus` | number | only for API | HTTP status code to expect (default: 200) |
| `expectedResponse` | object | optional | Validate specific response values using path notation |

### expectedResponse Object

The `expectedResponse` object allows granular validation of API responses:

```javascript
expectedResponse: {
  path: 'string',  // Dot notation path to the value (e.g., 'body.status' or 'data.health.status')
  value: 'any'     // Expected value at that path
}
```

## Unified Checks (type: 'all')

Type `all` combines ping and API monitoring into a single monitor, showing both network connectivity and service health in one line.

### Benefits of Unified Checks

1. **Single Line Display** - Instead of two separate monitors, combine them
2. **Network vs Service Issues** - Distinguish between network problems and application issues
3. **Complete Visibility** - See if server is reachable AND healthy in one glance

### Status for Unified Checks

| Status | Meaning | Ping | API | Action |
|--------|---------|------|-----|--------|
| **UP** | All checks pass | ✓ | ✓ | No action |
| **UNHEALTHY** | Server up but health check fails | ✓ | ✓ | Check service dependencies |
| **DEGRADED** | Partial connectivity issue | one fails | varies | Investigate routing/firewall |
| **DOWN** | Server completely offline | ✗ | ✗ | Restart service |

### Example Configuration

```javascript
// Simple unified check
{
  name: 'Web Service',
  type: 'all',
  target: '10.0.1.100',                     // IP for ping
  apiTarget: 'https://service.example.com/health',  // URL for API
  timeout: 10000,
  expectedStatus: 200
}

// With health validation
{
  name: 'Database Service',
  type: 'all',
  target: '10.0.2.50',
  apiTarget: 'https://db.example.com/health',
  timeout: 10000,
  expectedStatus: 200,
  expectedResponse: {
    path: 'status',
    value: 'healthy'
  }
}

// With nested health check
{
  name: 'Cache Service',
  type: 'all',
  target: '10.0.3.50',
  apiTarget: 'https://cache.example.com/health',
  timeout: 10000,
  expectedStatus: 200,
  expectedResponse: {
    path: 'redis.status',
    value: 'connected'
  }
}
```

### When to Use Each Type

- **type: 'ping'** - Quick network checks, no service-specific health
- **type: 'api'** - Cloud services, external APIs, load-balanced endpoints
- **type: 'all'** - Internal services where you need both network AND health checks


**Examples:**
```javascript
// Check nested JSON field
expectedResponse: {
  path: 'status',
  value: 'ok'
}

// Check deeply nested field
expectedResponse: {
  path: 'data.health.status',
  value: 'healthy'
}

// Check array or object existence
expectedResponse: {
  path: 'users.0.id',
  value: 'user123'
}
```

## Complete Example Configuration

```javascript
module.exports = {
  refreshInterval: 30000,  // Check every 30 seconds

  servers: [
    // Basic ping checks
    {
      name: 'Web Server 1',
      type: 'ping',
      target: '10.0.1.100',
      timeout: 5000
    },
    {
      name: 'Web Server 2',
      type: 'ping',
      target: '10.0.1.101',
      timeout: 5000
    },
    
    // API with basic status check
    {
      name: 'Main API - Status Only',
      type: 'api',
      target: 'https://api.example.com/health',
      timeout: 10000,
      expectedStatus: 200
    },
    
    // API with response validation (granular health check)
    {
      name: 'Main API - Full Health',
      type: 'api',
      target: 'https://api.example.com/health',
      timeout: 10000,
      expectedStatus: 200,
      expectedResponse: {
        path: 'status',
        value: 'ok'
      }
    },
    
    // API with nested response validation
    {
      name: 'Database Health',
      type: 'api',
      target: 'https://api.example.com/system/health',
      timeout: 10000,
      expectedStatus: 200,
      expectedResponse: {
        path: 'services.database.status',
        value: 'healthy'
      }
    },
    
    // API with multiple service checks
    {
      name: 'Cache Service',
      type: 'api',
      target: 'https://api.example.com/health',
      timeout: 10000,
      expectedStatus: 200,
      expectedResponse: {
        path: 'checks.redis',
        value: 'pass'
      }
    },
    
    // Other servers
    {
      name: 'Database Server',
      type: 'ping',
      target: '10.0.2.50',
      timeout: 5000
    }
  ]
};
```

### Output Example

When a health check fails at the response level:
```
API Service         api    https://api.example.com/health  ⚠ UNHEALTHY  200  14:32:19  status: "degraded" (expected "ok")
```

When server is down:
```
API Service         api    https://api.example.com/health  ✗ DOWN       N/A  14:32:19  HTTP N/A
```

When response parsing fails:
```
API Service         api    https://api.example.com/health  ⚠ UNHEALTHY  200  14:32:19  data.status: null (expected "ok")
```

## Output

The dashboard displays:

```
┌─ SERVER MONITORING DASHBOARD ─┐
│ Uptime: 5/5 servers UP
│ Refresh: every 60s | Next check in 60s
└────────────────────────────────┘

Server Name              Type      Target                              Status       Code     Last Check      Error
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Web Server 1            ping      8.8.8.8                             ✓ UP         ✓        14:32:15        -
Web Server 2            ping      1.1.1.1                             ✓ UP         ✓        14:32:16        -
API Server              api       https://api.github.com/repos/...    ✓ UP         200      14:32:17        -
Health Check API        api       https://httpbin.org/status/200      ✓ UP         200      14:32:18        -
Database Server         ping      8.8.4.4                             ✗ DOWN       ✗        14:32:19        Timeout

Last updated: 14:32:19
Press Ctrl+C to exit
```

## Common Use Cases

### Monitor Internal Network
```javascript
{
  name: 'Internal Wiki',
  type: 'ping',
  target: '192.168.1.50',
  timeout: 5000
}
```

### Monitor Docker Containers
```javascript
{
  name: 'Docker Service API',
  type: 'api',
  target: 'http://localhost:8080/health',
  timeout: 5000,
  expectedStatus: 200
}
```

### Monitor Kubernetes Health
```javascript
{
  name: 'K8s Cluster',
  type: 'api',
  target: 'https://kubernetes.example.com/api/v1/health',
  timeout: 10000,
  expectedStatus: 200,
  checkField: 'status'
}
```

### Monitor Multiple Environments
```javascript
servers: [
  // Development
  {
    name: 'Dev API',
    type: 'api',
    target: 'https://dev-api.example.com/health',
    timeout: 10000,
    expectedStatus: 200
  },
  // Staging
  {
    name: 'Staging API',
    type: 'api',
    target: 'https://staging-api.example.com/health',
    timeout: 10000,
    expectedStatus: 200
  },
  // Production
  {
    name: 'Production API',
    type: 'api',
    target: 'https://api.example.com/health',
    timeout: 10000,
    expectedStatus: 200
  }
]
```

## Troubleshooting

### Ping not working on macOS/Linux
Make sure your user has permission to use the ping command, or run with `sudo`:
```bash
sudo yarn start
```

### API checks failing with SSL errors
If monitoring self-signed HTTPS endpoints, you may need to disable SSL verification (not recommended for production). Modify the https request handling in the script.

### High CPU usage
Reduce the number of monitors or increase the `refreshInterval` to check less frequently.

### Network timeouts
Increase the `timeout` value for slower networks or add the `--timeout=X` flag when running npm.

## Performance Tips

- Set reasonable timeout values (1-15 seconds)
- Don't monitor more than 50 endpoints simultaneously
- Increase refresh interval for better performance
- Consider running multiple monitor instances for different server groups

## License

MIT
