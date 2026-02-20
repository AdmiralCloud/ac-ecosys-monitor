#!/usr/bin/env node

/**
 * Server Monitoring Dashboard
 * Monitors server availability via ping and API calls
 * Displays results in a refreshing table format
 */

const { spawn, exec } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');
const { promisify } = require('node:util');

const Table = require('cli-table3');
const { Chalk } = require('chalk');

const config = require('./config');

const execPromise = promisify(exec);
const isLinux = require('node:os').type() === 'Linux';
const chalk = new Chalk()

const PING_IN_MILLISECONDS = isLinux ? 1000 : 1 // linux ping is in seconds

class ServerMonitor {
  constructor(config) {
    this.config = config;
    this.results = [];
    this.startTime = new Date();
    this.sshCache = {};  // Cache for SSH checks with timestamps
  }

  getLocaleTimeString(date) {
    return (date !== undefined ? new Date(date) : new Date()).toLocaleTimeString(undefined, { hour12: false })
  }

  /**
   * Perform a ping to check server availability
   */
  async ping(target, timeout) {
    try {
      const command = `ping -c 1 -W ${Math.floor(timeout / PING_IN_MILLISECONDS)} ${target}`;
      const { stdout, stderr } = await execPromise(command, { timeout });

      // Check if ping was successful
      return !stderr && (stdout.includes('1 packets transmitted, 1 received, 0% packet loss') || stdout.includes('1 packets received'));
    } catch {
      return false;
    }
  }

  /**
   * Get value from object using dot notation path
   */
  getValueByPath(obj, path) {
    return path.split('.').reduce((current, prop) => current?.[prop], obj);
  }

  /**
   * Calculate dynamic column widths based on terminal width
   */
  calculateColumnWidths() {
    const terminalWidth = process.stdout.columns || 120;

    // [Name, Type, Target, Status, Code, LastCheck, Details]
    let widths
    if (terminalWidth < 100) {
      // Narrow: 80-99 cols
      widths = [14, 7, 25, 10, 6, 12];
    }
    else if (terminalWidth < 140) {
      // Standard: 100-139 cols (most common)
      widths = [18, 8, 35, 17, 8, 12];
    }
    else if (terminalWidth < 180) {
      // Wide: 140-179 cols
      widths = [22, 8, 45, 17, 8, 12];
    }
    else {
      // Very wide: 180+ cols
      widths = [25, 8, 55, 17, 8, 12];
    }

    widths.push(terminalWidth - widths.reduce((a, b) => a + b, 9)); // the rest width is given to last column

    return widths
  }

  /**
   * Check SSH using native ssh command and get MOTD for system updates info
   */
  async checkSSH(host, port, username) {
    return new Promise((resolve) => {
      const sshParams = [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'StrictHostKeyChecking=accept-new',
      ];
      if (port) sshParams.push('-p', port)

      sshParams.push(username ? `${username}@${host}` : host)
      sshParams.push('run-parts /etc/update-motd.d/')

      const ssh = spawn('ssh', sshParams);

      let output = '';
      const timeout = setTimeout(() => {
        ssh.kill();
        resolve({
          success: false,
          error: 'SSH timeout',
          motd: null,
          rebootRequired: false,
          updates: null
        });
      }, 15000);

      ssh.stdout.on('data', (data) => {
        output += data.toString();
      });

      ssh.stderr.on('data', (data) => {
        output += data.toString();
      });

      ssh.on('close', () => {
        clearTimeout(timeout);
        const updatesMatch = output.match(/(\d+)\s+updates?\s+can be applied immediately/i);
        const securityMatch = output.match(/(\d+)\s+of these updates?\s+(?:is|are)\s+(?:a )?standard security updates?/i);
        const rebootRequired = output.includes('System restart required');

        let updatesInfo = '';
        if (updatesMatch && 0 !== +String(updatesMatch[1])) {
          updatesInfo = `${updatesMatch[1]} updates`;
          if (securityMatch) {
            updatesInfo += ` (${securityMatch[1]} security)`;
          }
        }

        resolve({
          success: true,
          error: null,
          motd: output,
          rebootRequired: rebootRequired,
          updates: updatesInfo || null,
          lastCheck: this.getLocaleTimeString(),
        });
      });
    });
  }

  async checkApi(target, timeout, expectedStatus, expectedResponse) {
    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        resolve({
          success: false,
          statusCode: null,
          statusOk: false,
          responseOk: null,
          error: 'Timeout'
        });
      }, timeout);

      const protocol = target.startsWith('https') ? https : http;
      const request = protocol.get(target, (res) => {
        clearTimeout(timeoutHandle);
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const statusOk = res.statusCode === expectedStatus;
            let responseOk = true;
            let responseCheckDetails = null;

            // Check response body if expectedResponse is defined
            if (expectedResponse && statusOk) {
              try {
                const jsonData = JSON.parse(data);
                const actual = this.getValueByPath(jsonData, expectedResponse.path);
                responseOk = actual === expectedResponse.value;
                responseCheckDetails = {
                  path: expectedResponse.path,
                  expected: expectedResponse.value,
                  actual,
                  match: responseOk,
                };
              } catch (e) {
                responseOk = false;
                responseCheckDetails = {
                  path: expectedResponse.path,
                  expected: expectedResponse.value,
                  actual: null,
                  match: false,
                  parseError: true
                };
              }
            }

            resolve({
              success: statusOk && responseOk,
              statusCode: res.statusCode,
              statusOk,
              responseOk,
              responseCheckDetails: responseCheckDetails,
              error: null
            });
          } catch (e) {
            resolve({
              success: false,
              statusCode: null,
              statusOk: false,
              responseOk: null,
              error: e.message
            });
          }
        });
      });

      request.on('error', (error) => {
        clearTimeout(timeoutHandle);
        resolve({
          success: false,
          statusCode: null,
          statusOk: false,
          responseOk: null,
          error: error.message
        });
      });

      request.on('timeout', () => {
        clearTimeout(timeoutHandle);
        request.destroy();
        resolve({
          success: false,
          statusCode: null,
          statusOk: false,
          responseOk: null,
          error: 'Timeout'
        });
      });
    });
  }

  /**
   * Check a single server based on its type
   */
  async checkServer(server) {
    let result;

    try {
      if (server.type === 'ping') {
        const isAlive = await this.ping(server.target, server.timeout);
        result = {
          name: server.name,
          type: server.type,
          target: server.target,
          status: isAlive ? 'UP' : 'DOWN',
          statusCode: isAlive ? '✓' : '✗',
          lastCheck: this.getLocaleTimeString(),
          error: null,
          details: null,
          sshInfo: null
        };
      } else if (server.type === 'ssh') {
        // SSH check for updates and reboot status
        const sshHost = server.host;
        const sshPort = server.port || server.username && 22;
        const sshUser = server.username;
        const cacheKey = `${sshHost}:${sshPort}:${sshUser}`;
        const checkInterval = server.sshCheckInterval || 3600000; // 1 hour default

        let sshResult = null;

        // Check if we have cached result and it's still valid
        if (this.sshCache[cacheKey]) {
          const timeSinceLastCheck = Date.now() - this.sshCache[cacheKey].timestamp;
          if (timeSinceLastCheck < checkInterval) {
            sshResult = this.sshCache[cacheKey].result;
            sshResult.timestamp = this.sshCache[cacheKey].timestamp
          }
        }

        // If no valid cache, perform SSH check
        if (!sshResult) {
          sshResult = await this.checkSSH(sshHost, sshPort, sshUser);
          this.sshCache[cacheKey] = {
            result: sshResult,
            timestamp: Date.now()
          };
        }

        let status = 'UP';
        let statusCode = '✓';
        let error = null;

        if (!sshResult.success) {
          status = 'DOWN';
          statusCode = '✗';
          error = sshResult.error;
        } else if (sshResult.rebootRequired || sshResult.updates) {
          status = 'MAINTENANCE';
          statusCode = '⚠';
        }

        result = {
          name: server.name,
          type: server.type,
          target: `${sshUser ? `${sshUser}@` : ''}${sshHost}${sshPort ? `:${sshPort}` : ''}`,
          status: status,
          statusCode: statusCode,
          lastCheck: sshResult.lastCheck || this.getLocaleTimeString(),
          error: error,
          details: {
            rebootRequired: sshResult.rebootRequired,
            updates: sshResult.updates
          },
          sshInfo: sshResult
        };
      } else if (server.type === 'api') {
        const apiResult = await this.checkApi(
          server.target,
          server.timeout,
          server.expectedStatus,
          server.expectedResponse
        );

        // Determine overall status
        let status = 'UP';
        let statusDetails = null;

        if (!apiResult.statusOk && apiResult.responseOk === null) {
          // Connection failed or status code wrong
          status = 'DOWN';
          statusDetails = `HTTP ${apiResult.statusCode || 'N/A'}`;
        } else if (!apiResult.statusOk) {
          // Status code mismatch
          status = 'DOWN';
          statusDetails = `HTTP ${apiResult.statusCode} (expected ${server.expectedStatus})`;
        } else if (apiResult.responseOk === false) {
          // Status ok but response validation failed
          status = 'UNHEALTHY';
          statusDetails = `Health check failed`;
        }

        result = {
          name: server.name,
          type: server.type,
          target: server.target,
          status: apiResult.success ? 'UP' : status,
          statusCode: apiResult.statusCode || 'N/A',
          lastCheck: server.lastCheck || this.getLocaleTimeString(),
          error: apiResult.error,
          details: {
            statusOk: apiResult.statusOk,
            responseOk: apiResult.responseOk,
            responseCheckDetails: apiResult.responseCheckDetails,
            statusDetails: statusDetails
          },
          sshInfo: null
        };
      } else if (server.type === 'all') {
        // Unified check: ping + API + optional SSH
        const pingResult = await this.ping(server.target, server.timeout);
        const apiResult = await this.checkApi(
          server.apiTarget,
          server.timeout,
          server.expectedStatus,
          server.expectedResponse
        );

        // Optional SSH check
        let sshResult = null;
        if (server.ssh?.enabled) {
          const sshHost = server.ssh.host || server.target;
          const sshPort = server.ssh.port || server.ssh.username && 22;
          const sshUser = server.ssh.username;
          const cacheKey = `${sshHost}:${sshPort}:${sshUser}`;
          const checkInterval = server.ssh.checkInterval || 3600000; // 1 hour default

          // Check if we have cached result and it's still valid
          if (this.sshCache[cacheKey]) {
            const timeSinceLastCheck = Date.now() - this.sshCache[cacheKey].timestamp;
            if (timeSinceLastCheck < checkInterval) {
              sshResult = this.sshCache[cacheKey].result;
            }
          }

          // If no valid cache, perform SSH check
          if (!sshResult) {
            sshResult = await this.checkSSH(sshHost, sshPort, sshUser);
            this.sshCache[cacheKey] = {
              result: sshResult,
              timestamp: Date.now()
            };
          }
        }

        // Determine overall status based on checks
        let status = 'UP';
        let statusDetails = null;
        let combinedError = null;

        const pingOk = pingResult;

        if (!pingOk && !apiResult.success) {
          // Both failed
          status = 'DOWN';
          statusDetails = 'Ping failed + API unreachable';
          combinedError = 'Both ping and API failed';
        } else if (!pingOk) {
          // Ping failed but API works
          status = 'DEGRADED';
          statusDetails = 'Ping failed but API responding';
          combinedError = 'Network issue (ping failed)';
        } else if (!apiResult.statusOk && apiResult.responseOk === null) {
          // API unreachable but ping works
          status = 'DEGRADED';
          statusDetails = 'Ping OK but API unreachable';
          combinedError = apiResult.error || `HTTP ${apiResult.statusCode || 'N/A'}`;
        } else if (!apiResult.statusOk) {
          // Status code wrong but ping works
          status = 'DEGRADED';
          statusDetails = `Ping OK, HTTP ${apiResult.statusCode} (expected ${server.expectedStatus})`;
          combinedError = 'API returned wrong status';
        } else if (apiResult.responseOk === false) {
          // Status ok but response validation failed and ping works
          status = 'UNHEALTHY';
          statusDetails = 'Ping OK, health check failed';
          combinedError = 'Health check failed';
        }

        // Check SSH status if available
        if (sshResult && !sshResult.success) {
          if (status === 'UP') {
            status = 'DEGRADED';
            statusDetails = 'SSH check failed';
            combinedError = sshResult.error;
          }
        } else if (sshResult && (sshResult.rebootRequired || sshResult.updates)) {
          if (status === 'UP') {
            status = 'MAINTENANCE';
            statusDetails = 'Updates/reboot pending';
          }
        }

        result = {
          name: server.name,
          type: server.type,
          target: `${server.target} / ${server.apiTarget}`,
          status: pingOk && apiResult.success ? status : status,
          statusCode: pingOk ? '✓' : '✗',
          lastCheck: server.lastCheck || this.getLocaleTimeString(),
          error: combinedError,
          details: {
            pingOk: pingOk,
            apiStatusOk: apiResult.statusOk,
            responseOk: apiResult.responseOk,
            responseCheckDetails: apiResult.responseCheckDetails,
            statusDetails: statusDetails,
            sshRebootRequired: sshResult?.rebootRequired,
            sshUpdates: sshResult?.updates
          },
          sshInfo: sshResult
        };
      }
    } catch (error) {
      result = {
        name: server.name,
        type: server.type,
        target: server.target,
        status: 'ERROR',
        statusCode: 'N/A',
        lastCheck: this.getLocaleTimeString(),
        error: error.message,
        details: null
      };
    }

    if (server.groupName) result.groupName = server.groupName

    return result;
  }

  /**
   * Check all servers
   */
  async checkAllServers(servers, group) {
    // const checkPromises = servers.map(server => this.checkServer(server));
    const checkPromises = []
    for (let i = 0; i < servers.length; i++) {
      if (servers[i].type === 'group') {
        // this.results.concat(await this.checkAllServers(servers[i].servers, servers[i].name))
        for (let j = 0; j < servers[i].servers.length; j++) {
          servers[i].servers[j].groupName = servers[i].name
          checkPromises.push(this.checkServer(servers[i].servers[j]))
        }
        continue
      }

      checkPromises.push(this.checkServer(servers[i]))
    }

    this.results = await Promise.all(checkPromises);
  }

  /**
   * Format status with color
   */
  formatStatus(status) {
    switch (status) {
      case 'UP':
        return chalk.green('✓ UP');
      case 'DOWN':
        return chalk.red('✗ DOWN');
      case 'UNHEALTHY':
        return chalk.yellow('⚠ UNHEALTHY');
      case 'DEGRADED':
        return chalk.yellow('⚠ DEGRADED');
      case 'MAINTENANCE':
        return chalk.blue('ℹ MAINTENANCE');
      case 'ERROR':
        return chalk.red('⚠ ERROR');
      default:
        return status;
    }
  }

  /**
   * Format details for display
   */
  formatDetails(result) {
    if (!result.details) {
      return result.error || '-';
    }

    const { statusOk, responseOk, responseCheckDetails, statusDetails, sshRebootRequired, sshUpdates } = result.details;

    // If it's a ping check
    if (result.type === 'ping') {
      return result.error || '-';
    }

    // If it's an SSH check
    if (result.type === 'ssh') {
      let details = [];
      if (result.error) {
        details.push(result.error);
      } else {
        if (result.sshInfo?.rebootRequired) {
          details.push('⚠ Reboot required');
        }
        if (result.sshInfo?.updates) {
          details.push(result.sshInfo.updates);
        }
      }
      return details.length > 0 ? details.join(' | ') : 'OK';
    }

    // If it's an API or all check
    let details = [];

    if (!statusOk) {
      details.push(statusDetails || `HTTP ${result.statusCode}`);
    }

    if (responseOk === false && responseCheckDetails) {
      const { path, expected, actual } = responseCheckDetails;
      details.push(`${path}: "${actual}" (expected "${expected}")`);
    }

    // Add SSH info if present
    if (sshRebootRequired) {
      details.push('⚠ Reboot required');
    }
    if (sshUpdates) {
      details.push(sshUpdates);
    }

    if (result.error) {
      details.push(result.error);
    }

    return details.length > 0 ? details.join(' | ') : '-';
  }

  /**
   * Display results in a table
   */
  displayTable() {
    // Clear console
    console.clear();

    const upCount = this.results.filter(r => ['UP', 'MAINTENANCE'].includes(r.status)).length;
    const totalCount = this.results.length;

    const dashTable = new Table({
      head: [{ hAlign: 'center', content: 'SERVER MONITORING DASHBOARD' }],
      style: { head: ['bold'], border: ['white'], compact: true },
    });
    dashTable.push(
      [chalk[upCount === totalCount ? 'green' : 'red'](`Uptime: ${upCount}/${totalCount} servers UP`)],
      [`Refresh: every ${this.config.refreshInterval / 1000}s | Next check at ${this.getLocaleTimeString(Date.now() + this.config.refreshInterval)}`],
    );

    console.log(dashTable.toString());
    console.log('\n');

    const table = new Table({
      head: [
        chalk.cyan('Server Name'),
        chalk.cyan('Type'),
        chalk.cyan('Target'),
        chalk.cyan('Status'),
        chalk.cyan('Code'),
        chalk.cyan('Last Check'),
        chalk.cyan('Details')
      ],
      style: {
        head: [],
        border: ['cyan'],
        compact: true,
      },
      wordWrap: true,
      colWidths: this.calculateColumnWidths(),
    });

    let lastGroupName
    this.results.forEach(result => {
      if (result.groupName && lastGroupName !== result.groupName) {
        table.push([{ colSpan: 7, content: '' }])
        table.push([{ content: chalk.bold.white(result.groupName), colSpan: 7 }])
        lastGroupName = result.groupName
      }
      else if (lastGroupName && !result.groupName) {
        lastGroupName = undefined
        table.push([{ colSpan: 7, content: '' }])
      }

      table.push([
        chalk.white(result.name),
        chalk.gray(result.type),
        chalk.gray(result.target),
        this.formatStatus(result.status),
        chalk.gray(String(result.statusCode)),
        chalk.gray(result.lastCheck),
        chalk.gray(this.formatDetails(result))
      ]);
    });

    console.log(table.toString());

    console.log(chalk.dim(`\nLast updated: ${this.getLocaleTimeString()}`));
    console.log(chalk.dim('Press Ctrl+C to exit\n'));
  }

  /**
   * Start monitoring loop
   */
  async start() {
    console.log(chalk.yellow('Starting server monitor...'));

    // Initial check
    await this.checkAllServers(this.config.servers);
    this.displayTable();

    // Set interval for subsequent checks
    setInterval(async () => {
      await this.checkAllServers(this.config.servers);
      this.displayTable();
    }, this.config.refreshInterval);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\nShutting down monitor...\n'));
      process.exit(0);
    });
  }
}

// Create and start monitor
const monitor = new ServerMonitor(config);
monitor.start();
