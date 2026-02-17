const fs = require('node:fs')
const path = require('node:path')

/**
 * Server Monitoring Configuration
 * Define your servers, ping targets, and API endpoints here
 */

const defaultConfig = {
  // Refresh interval in milliseconds (default: 60000 = 1 minute)
  refreshInterval: 60000,

  // Servers to monitor
  servers: [
    // PING
    {
      name: 'Cloudflare DNS',
      type: 'ping',
      target: '1.1.1.1',
      timeout: 200
    },
    // UNIFIED: PING + API + SSH
    {
      name: 'Service with Updates Check',
      type: 'all',
      target: '1.1.1.1',
      apiTarget: 'https://httpbin.org/json',
      timeout: 1000,
      expectedStatus: 200,
      expectedResponse: {
        path: 'slideshow.title',
        value: 'Sample Slide Show'
      },
      ssh: {
        enabled: true,
        username: 'ubuntu',
        checkInterval: 3600000
      }
    }
  ]
};

// Deep merge function
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      target[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// Try loading local override
const localPath = path.join(__dirname, 'env', 'local.js');

if (fs.existsSync(localPath)) {
  const localConfig = require(localPath);
  deepMerge(defaultConfig, localConfig);
}


module.exports = defaultConfig;