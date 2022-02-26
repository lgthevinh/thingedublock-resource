const fs = require('fs-extra');
const path = require('path');
const request = require('request');
const progress = require('request-progress');
const hashFiles = require('hash-files');
const extract = require('extract-zip');
const fetch = require('node-fetch');
const parseMessage = require('openblock-parse-release-message');
const byteSize = require('byte-size');
const clc = require('cli-color');
const lockFile = require('proper-lockfile');

const {UPGRADE_STATE, UPGRADE_PROGRESS, UPGRADE_CONTENT} = require('./state');
const {checkDirHash} = require('./calc-dir-hash');
const {formatTime} = require('./format');
const {DIRECTORY_NAME} = require('./config');
const getConfigHash = require('./get-config-hash');

class ResourceUpgrader {
    constructor (repo, cdn, workDir) {
        this._repo = repo;
        this._cdn = cdn;
        this._workDir = workDir;

        this.progress = 0; // 0 ~ 1
    }

    getLatest () {
        let url = `https://api.github.com/repos/${this._repo}/releases/latest`;

        if (this._cdn) {
            url = `${this._cdn}/${url}`;
        }

        return new Promise((resolve, reject) => {
            fetch(url)
                .then(res => resolve(res.json()))
                .catch(err => reject(err));
        });
    }

    checkUpdate () {
        if (lockFile.checkSync(this._workDir)) {
            const e = 'Resource is upgrading';
            console.log(clc.yellow(e));
            return Promise.reject(e);
        }

        return new Promise((resolve, reject) => {
            this.getLatest(this._repo, this._cdn)
                .then(info => {
                    if (info.tag_name) {
                        const version = info.tag_name;
                        const message = parseMessage(info.body);

                        return resolve({latestVersion: version, message: message});
                    }
                    return reject(`Cannot get valid releases from: ${this._repo}`);
                })
                .catch(err => reject(err));
        });
    }

    download (url, dest, callback) {
        if (this._cdn) {
            url = `${this._cdn}/${url}`;
        }

        if (callback) {
            callback({
                phase: UPGRADE_STATE.downloading,
                progress: this.progress,
                info: {
                    name: path.basename(dest)
                }
            });
        }

        return new Promise((resolve, reject) => {
            progress(request(url))
                .on('progress', state => {
                    if (this.progress >= UPGRADE_PROGRESS.start && this.progress < UPGRADE_PROGRESS.downloadResource) {
                        this.progress = UPGRADE_PROGRESS.start +
                            (state.percent * (UPGRADE_PROGRESS.downloadResource - UPGRADE_PROGRESS.start));
                    } else {
                        this.progress = UPGRADE_PROGRESS.downloadResource +
                            (state.percent * (UPGRADE_PROGRESS.downloadChecksum - UPGRADE_PROGRESS.downloadResource));
                    }
                    if (callback) {
                        callback({
                            phase: UPGRADE_STATE.downloading,
                            progress: this.progress,
                            info: {
                                name: path.basename(dest),
                                percent: state.percent, // 0 ~ 1
                                speed: `${byteSize(state.speed)}/s`,
                                total: `${byteSize(state.size.total)}`,
                                transferred: `${byteSize(state.size.transferred)}`,
                                remaining: formatTime(state.time.remaining)
                            }
                        });
                    }
                })
                .on('error', err => reject(err))
                .on('end', () => resolve())
                .pipe(fs.createWriteStream(dest));
        });
    }

    upgrade (version, callback) {
        if (lockFile.checkSync(this._workDir)) {
            const e = 'A resource upgrader is already running';
            console.log(clc.yellow(e));
            return Promise.reject(e);
        }

        const shortVersion = version.replace(/v/g, '');

        const downloadPath = path.resolve(this._workDir, 'download');
        fs.ensureDirSync(downloadPath);

        const resourceName = `external-resources-${shortVersion}.zip`;
        const resourceUrl = `https://github.com/${this._repo}/releases/download/${version}/${resourceName}`;
        const resourcePath = path.join(downloadPath, resourceName);

        const checksumName = `${shortVersion}-checksums-sha256.txt`;
        const checksumUrl = `https://github.com/${this._repo}/releases/download/${version}/${checksumName}`;
        const checksumPath = path.join(downloadPath, checksumName);

        lockFile.lockSync(this._workDir);

        this.progress = UPGRADE_PROGRESS.start;
        if (callback) {
            callback({
                phase: UPGRADE_STATE.downloading,
                progress: this.progress
            });
        }

        // Step 1: download zip and checksun file.
        return this.download(resourceUrl, resourcePath, callback)
            .then(() => this.download(checksumUrl, checksumPath, callback))
            .then(() => {
                // Step 2: check checksum of zip.
                this.progress = UPGRADE_PROGRESS.verifyZip;
                if (callback){
                    callback({
                        phase: UPGRADE_STATE.verifying,
                        progress: this.progress,
                        info: {name: UPGRADE_CONTENT.zip}
                    });
                }
                const zipChecksum = fs.readFileSync(checksumPath, 'utf8').split('  ')[0];
                const hash = hashFiles.sync({files: resourcePath, algorithm: 'sha256'});

                if (zipChecksum === hash) {
                    // Step 3: delete old directory.
                    const extractPath = path.resolve(this._workDir, DIRECTORY_NAME);
                    this.progress = UPGRADE_PROGRESS.deletCache;
                    if (callback) {
                        callback({
                            phase: UPGRADE_STATE.deleting,
                            progress: this.progress,
                            info: {name: UPGRADE_CONTENT.cache}
                        });
                    }
                    fs.rmSync(extractPath, {recursive: true, force: true});

                    // Step 4: extract zip.
                    this.progress = UPGRADE_PROGRESS.extractZip;
                    if (callback) {
                        callback({
                            phase: UPGRADE_STATE.extracting,
                            progress: this.progress
                        });
                    }
                    return extract(resourcePath, {dir: extractPath})
                        .then(() => {
                            // Step 5: check checksum of extracted directory.
                            this.progress = UPGRADE_PROGRESS.verifyCache;
                            if (callback) {
                                callback({
                                    phase: UPGRADE_STATE.verifying,
                                    progress: this.progress,
                                    info: {name: UPGRADE_CONTENT.cache}
                                });
                            }

                            const configFilePath = path.resolve(extractPath, 'config.json');
                            const dirHash = getConfigHash(configFilePath);
                            if (!dirHash) {
                                console.warn(clc.yellow(`WARN: no hash value found in ${configFilePath}`));
                                return Promise.resolve();
                            }
                            return checkDirHash(extractPath, dirHash);
                        })
                        .then(() => {
                            // Step 6.1: delete downloaded files.
                            this.progress = UPGRADE_PROGRESS.deletZip;
                            if (callback) {
                                callback({
                                    phase: UPGRADE_STATE.deleting,
                                    progress: this.progress,
                                    info: {name: UPGRADE_CONTENT.zip}
                                });
                            }

                            fs.rmSync(resourcePath, {recursive: true, force: true});
                            fs.rmSync(checksumPath, {recursive: true, force: true});
                            lockFile.unlockSync(this._workDir);
                        })
                        .catch(err => {
                            // Step 6.2: if check failed, delete extracted directory.
                            if (callback) {
                                callback({
                                    phase: UPGRADE_STATE.deleting,
                                    progress: this.progress,
                                    info: {name: UPGRADE_CONTENT.cache}
                                });
                            }
                            fs.rmSync(extractPath, {recursive: true, force: true});
                            lockFile.unlockSync(this._workDir);
                            return Promise.reject(err);
                        });
                }
                lockFile.unlockSync(this._workDir);
                return Promise.reject(`${resourcePath} has failed the checksum detection`);
            })
            .catch(err => {
                lockFile.unlockSync(this._workDir);
                return Promise.reject(err);
            });
    }
}

module.exports = ResourceUpgrader;
