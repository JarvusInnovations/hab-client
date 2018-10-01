const semver = require('semver');
const _ = require('underscore');
const axios = require('axios');
const child_process = require('child_process');
const logger = require('./logger');

/**
 * Represents and provides an interface to an executable hab binary
 * available in the host environment
 */
class Hab {

    constructor ({ command = null, supervisorApi = null } = {}) {
        this.command = command || this.command;
        this.supervisorApi = axios.create({
            baseURL: supervisorApi || this.supervisorApi
        });

        this.version = null;
        this.build = null;
    }

    /**
     * Get the version of the hab binary
     * @returns {?string} Version reported by habitat binary, or null if not available
     */
    async getVersion () {
        if (this.version === null) {
            try {
                const output = await this.exec({ version: true });
                [, this.version, this.build] = /^hab ([^\/]+)\/(\d+)$/.exec(output);
            } catch (err) {
                this.version = false;
            }
        }

        return this.version || null;
    }

    /**
     * Check if hab version is satisfied
     * @param {string} range - The version or range habitat should satisfy (see https://github.com/npm/node-semver#ranges)
     * @returns {boolean} True if habitat version satisfies provided range
     */
    async satisfiesVersion (range) {
        return semver.satisfies(await this.getVersion(), range);
    }

    /**
     * Ensure that hab version is satisfied
     * @param {string} range - The version or range habitat should satisfy (see https://github.com/npm/node-semver#ranges)
     * @returns {Git} Returns current instance or throws exception if version range isn't satisfied
     */
    async requireVersion (range) {
        if (!await this.satisfiesVersion(range)) {
            throw new Error(`Habitat version must be ${range}, reported version is ${await this.getVersion()}`);
        }

        return this;
    }

    /**
     * @returns {Object[]|false} Array of service status objects or false if the supervisor is unavailable
     */
    async getSupervisorStatus () {
        try {
            const output = (await this.exec('svc', 'status')).split(/\n/);

            if (output.length == 1) {
                return [];
            }

            let columns;
            const services = [];
            for (let line of output) {
                line = line.split(/\s{2,}/);

                if (!columns) {
                    columns = line;
                    continue;
                }

                services.push(_.object(columns, line));
            }

            return services;
        } catch (err) {
            return false;
        }
    }

    /**
     * Gets axios instance for supervisor API
     * @returns {Object} axios
     */
    getSupervisorApi () {
        return this.supervisorApi;
    }

    /**
     * Gets array of services via supervisor API
     * @returns {Object[]} Array of services
     */
    async getServices () {
        const response = await this.getSupervisorApi().get('services');
        return response.data;
    }

    /**
     * Executes habitat with given arguments
     * @param {string|string[]} args - Arguments to execute
     * @param {?Object} execOptions - Extra execution options
     * @returns {Promise}
     */
    async exec (...args) {
        let command;
        const commandArgs = [];
        const commandEnv = {};
        const execOptions = {
            maxBuffer: 1024 * 1024 // 1 MB output buffer
        };


        // scan through all arguments
        let arg;

        while (arg = args.shift()) {
            switch (typeof arg) {
                case 'string':
                    if (!command) {
                        command = arg; // the first string is the command
                        break;
                    }
                    // fall through and get pushed with numbers
                case 'number':
                    commandArgs.push(arg.toString());
                    break;
                case 'object':

                    // extract any general execution options
                    if ('$nullOnError' in arg) {
                        execOptions.nullOnError = arg.$nullOnError;
                        delete arg.$nullOnError;
                    }

                    if ('$spawn' in arg) {
                        execOptions.spawn = arg.$spawn;
                        delete arg.$spawn;
                    }

                    if ('$shell' in arg) {
                        execOptions.shell = arg.$shell;
                        delete arg.$shell;
                    }

                    if ('$env' in arg) {
                        for (let key in arg.$env) {
                            commandEnv[key] = arg.$env[key];
                        }
                        delete arg.$env;
                    }

                    if ('$preserveEnv' in arg) {
                        execOptions.preserveEnv = arg.$preserveEnv;
                        delete arg.$preserveEnv;
                    }

                    if ('$options' in arg) {
                        for (let key in arg.$options) {
                            execOptions[key] = arg.$options[key];
                        }
                    }

                    if ('$passthrough' in arg) {
                        if (execOptions.passthrough = Boolean(arg.$passthrough)) {
                            execOptions.spawn = true;
                        }
                        delete arg.$passthrough;
                    }

                    if ('$wait' in arg) {
                        execOptions.wait = Boolean(arg.$wait);
                        delete arg.$wait;
                    }


                    // any remaiing elements are args/options
                    for (let key in arg) {
                        const value = arg[key];

                        if (key.length == 1) {
                            if (value === true) {
                                commandArgs.push('-'+key);
                            } else if (value !== false) {
                                commandArgs.push('-'+key, value);
                            }
                        } else {
                            if (value === true) {
                                commandArgs.push('--'+key);
                            } else if (value !== false) {
                                commandArgs.push('--'+key, value);
                            }
                        }
                    }

                    break;
                default:
                    throw 'unhandled exec argument';
            }
        }


        // prefixs args with command
        if (command) {
            commandArgs.unshift(command);
        }


        // prepare environment
        if (execOptions.preserveEnv !== false) {
            Object.setPrototypeOf(commandEnv, process.env);
        }

        execOptions.env = commandEnv;


        // execute git command
        logger.debug(this.command, commandArgs.join(' '));

        if (execOptions.spawn) {
            const process = child_process.spawn(this.command, commandArgs, execOptions);

            if (execOptions.passthrough) {
                process.stdout.on('data', data => data.toString().trim().split(/\n/).forEach(line => logger.info(line)));
                process.stderr.on('data', data => data.toString().trim().split(/\n/).forEach(line => logger.error(line)));
            }

            if (execOptions.wait) {
                return new Promise((resolve, reject) => {
                    process.on('exit', code => {
                        if (code == 0) {
                            resolve();
                        } else {
                            reject(code);
                        }
                    });
                });
            }

            let capturePromise;
            process.captureOutput = (input = null) => {
                if (!capturePromise) {
                    capturePromise = new Promise((resolve, reject) => {
                        let output = '';

                        process.stdout.on('data', data => {
                            output += data;
                        });

                        process.on('exit', code => {
                            if (code == 0) {
                                resolve(output);
                            } else {
                                reject({ output, code });
                            }
                        });
                    });
                }

                if (input) {
                    process.stdin.write(input);
                    process.stdin.end();
                }

                return capturePromise;
            };

            process.captureOutputTrimmed = async (input = null) => {
                return (await process.captureOutput(input)).trim();
            };

            return process;
        } else if (execOptions.shell) {
            return new Promise((resolve, reject) => {
                child_process.exec(`${this.command} ${commandArgs.join(' ')}`, execOptions, (error, stdout, stderr) => {
                    if (error) {
                        if (execOptions.nullOnError) {
                            return resolve(null);
                        } else {
                            error.stderr = stderr;
                            return reject(error);
                        }
                    }

                    resolve(stdout.trim());
                });
            });
        } else {
            return new Promise((resolve, reject) => {
                child_process.execFile(this.command, commandArgs, execOptions, (error, stdout, stderr) => {
                    if (error) {
                        if (execOptions.nullOnError) {
                            return resolve(null);
                        } else {
                            error.stderr = stderr;
                            return reject(error);
                        }
                    }

                    resolve(stdout.trim());
                });
            });
        }
    }
}


// set default habitat command
Hab.prototype.command = 'hab';
Hab.prototype.supervisorApi = 'http://localhost:9631';

// add first-class methods for common hab subcommands
[
    'bldr',
    'cli',
    'config',
    'file',
    'help',
    'origin',
    'pkg',
    'plan',
    'ring',
    'studio',
    'sup',
    'support-bundle',
    'svc',
    'user'
].forEach(command => {
    const method = command.replace(/-([a-zA-Z])/, (match, letter) => letter.toUpperCase());
    command = method.toLowerCase();

    Hab.prototype[method] = function (...args) {
        args.unshift(command);
        return this.exec.apply(this, args);
    };
});


// export class
module.exports = Hab;
