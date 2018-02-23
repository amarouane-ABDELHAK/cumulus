'use strict';

const path = require('path');
const get = require('lodash.get');
const log = require('@cumulus/common/log');
const parsePdr = require('./parse-pdr').parsePdr;
const ftpMixin = require('./ftp').ftpMixin;
const httpMixin = require('./http').httpMixin;
const sftpMixin = require('./sftp');
const aws = require('@cumulus/common/aws');

/**
 * This is a base class for discovering PDRs
 * It must be mixed with a FTP or HTTP mixing to work
 *
 * @class
 * @abstract
 */
class Discover {
  constructor(
    stack,
    bucket,
    collection,
    provider,
    folder = 'pdrs',
  ) {
    if (this.constructor === Discover) {
      throw new TypeError('Can not construct abstract class.');
    }

    this.stack = stack;
    this.bucket = bucket;
    this.collection = collection;
    this.provider = provider;
    this.folder = folder;

    // get authentication information
    this.port = get(this.provider, 'port', 21);
    this.host = get(this.provider, 'host', null);
    this.path = this.collection.provider_path || '/';
    this.username = get(this.provider, 'username', null);
    this.password = get(this.provider, 'password', null);
  }

  /**
   * discover PDRs from an endpoint
   * @return {Promise}
   * @public
   */
  async discover() {
    const files = await this.list();
    const pdrs = files.filter((file) => file.name.endsWith('.PDR'));
    return this.findNewPdrs(pdrs);
  }

  /**
   * Determine if a PDR does not yet exist in S3.
   *
   * @param {Object} pdr - the PDR that's being looked for
   * @param {string} pdr.name - the name of the PDR (in S3)
   * @returns {Promise.<(boolean|Object)>} - a Promise that resolves to false
   *   when the object does already exists in S3, or the passed-in PDR object
   *   if it does not already exist in S3.
   */
  pdrIsNew(pdr) {
    return aws.s3ObjectExists({
      Bucket: this.bucket,
      Key: path.join(this.stack, this.folder, pdr.name)
    }).then((exists) => (exists ? false : pdr));
  }

  /**
   * Determines which of the discovered PDRs are new
   * and has to be parsed by comparing the list of discovered PDRs
   * against a folder on a S3 bucket
   *
   * @param {array} pdrs list of pdr names (do not include the full path)
   * @return {Promise}
   * @private
   */
  async findNewPdrs(pdrs) {
    const checkPdrs = pdrs.map(pdr => this.pdrIsNew(pdr));
    const _pdrs = await Promise.all(checkPdrs);

    const newPdrs = _pdrs.filter(p => p);
    return newPdrs;
  }
}

/**
 * This is a base class for ingesting and parsing a single PDR
 * It must be mixed with a FTP or HTTP mixing to work
 *
 * @class
 * @abstract
 */
class Parse {
  constructor(
    pdr,
    stack,
    bucket,
    collection,
    provider,
    folder = 'pdrs') {
    if (this.constructor === Parse) {
      throw new TypeError('Can not construct abstract class.');
    }

    this.pdr = pdr;
    this.stack = stack;
    this.bucket = bucket;
    this.collection = collection;
    this.provider = provider;
    this.folder = folder;

    this.port = get(this.provider, 'port', 21);
    this.host = get(this.provider, 'host', null);

    this.username = get(this.provider, 'username', null);
    this.password = get(this.provider, 'password', null);
  }

  extractGranuleId(filename, regex) {
    const test = new RegExp(regex);
    const match = filename.match(test);

    if (match) {
      return match[1];
    }
    return filename;
  }

  /**
   * Copy the PDR to S3 and parse it
   *
   * @return {Promise}
   * @public
   */
  async ingest() {
    // download
    const pdrLocalPath = await this.download(this.pdr.path, this.pdr.name);

    // parse the PDR
    const granules = await this.parse(pdrLocalPath);

    // upload only if the parse was successful
    await this.upload(
      this.bucket,
      path.join(this.stack, this.folder),
      this.pdr.name,
      pdrLocalPath
    );

    // return list of all granules found in the PDR
    return granules;
  }

  /**
   * This method parses a PDR and returns all the granules in it
   *
   * @param {string} pdrLocalPath PDR path on disk
   * @return {Promise}
   * @public
   */
  parse(pdrLocalPath) {
    // catching all parse errors here to mark the pdr as failed
    // if any error occured
    const parsed = parsePdr(pdrLocalPath, this.collection, this.pdr.name);

    // each group represents a Granule record.
    // After adding all the files in the group to the Queue
    // we create the granule record (moment of inception)
    log.info(
      { pdrName: this.pdr.name },
      `There are ${parsed.granulesCount} granules in ${this.pdr.name}`
    );
    log.info(
      { pdrName: this.pdr.name },
      `There are ${parsed.filesCount} files in ${this.pdr.name}`
    );

    return parsed;
  }
}

/**
 * Discover PDRs from a FTP endpoint.
 *
 * @class
 */

class FtpDiscover extends ftpMixin(Discover) {}

/**
 * Discover PDRs from a HTTP endpoint.
 *
 * @class
 */

class HttpDiscover extends httpMixin(Discover) {}

/**
 * Discover PDRs from a SFTP endpoint.
 *
 * @class
 */

class SftpDiscover extends sftpMixin(Discover) {}

/**
 * Parse PDRs downloaded from a FTP endpoint.
 *
 * @class
 */

class FtpParse extends ftpMixin(Parse) {}

/**
 * Parse PDRs downloaded from a HTTP endpoint.
 *
 * @class
 */

class HttpParse extends httpMixin(Parse) {}

/**
 * Parse PDRs downloaded from a SFTP endpoint.
 *
 * @class
 */

class SftpParse extends sftpMixin(Parse) {}

/**
 * Select a class for discovering PDRs based on protocol
 *
 * @param {string} type - `discover` or `parse`
 * @param {string} protocol - `sftp`, `ftp`, or `http`
 * @returns {function} - a constructor to create a PDR discovery object
 */
function selector(type, protocol) {
  if (type === 'discover') {
    switch (protocol) {
      case 'http':
        return HttpDiscover;
      case 'ftp':
        return FtpDiscover;
      case 'sftp':
        return SftpDiscover;
      default:
        throw new Error(`Protocol ${protocol} is not supported.`);
    }
  }
  else if (type === 'parse') {
    switch (protocol) {
      case 'http':
        return HttpParse;
      case 'ftp':
        return FtpParse;
      case 'sftp':
        return SftpParse;
      default:
        throw new Error(`Protocol ${protocol} is not supported.`);
    }
  }

  throw new Error(`${type} is not supported`);
}

module.exports.selector = selector;
module.exports.HttpParse = HttpParse;
module.exports.FtpParse = FtpParse;
module.exports.SftpParse = SftpParse;
module.exports.FtpDiscover = FtpDiscover;
module.exports.HttpDiscover = HttpDiscover;
module.exports.SftpDiscover = SftpDiscover;
