'use strict';

const execa = require('execa');
const fs = require('fs');
const get = require('lodash.get');
const { Config } = require('kes');
const cloneDeep = require('lodash.clonedeep');
const dotenv = require('dotenv');
const mime = require('mime-types');
const merge = require('lodash.merge');
const path = require('path');
const { promisify } = require('util');
const pTimeout = require('p-timeout');
const tempy = require('tempy');
const yaml = require('js-yaml');

const {
  aws: {
    getS3Object,
    headObject,
    parseS3Uri,
    s3
  },
  stringUtils: { globalReplace },
  log
} = require('@cumulus/common');
const { isNil } = require('@cumulus/common/util');

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000000;

const promisedCopyFile = promisify(fs.copyFile);
const promisedReadFile = promisify(fs.readFile);
const promisedUnlink = promisify(fs.unlink);

const timestampedName = (name) => `${name}_${(new Date().getTime())}`;

const createTimestampedTestId = (stackName, testName) => `${stackName}-${testName}-${(new Date().getTime())}`;
const createTestDataPath = (prefix) => `${prefix}-test-data/files`;
const createTestSuffix = (prefix) => `_test-${prefix}`;

const MILLISECONDS_IN_A_MINUTE = 60 * 1000;

/**
 * Load a yml file
 *
 * @param {string} filePath - workflow yml filepath
 * @returns {Object} - JS Object representation of yml file
 */
function loadYmlFile(filePath) {
  return yaml.safeLoad(fs.readFileSync(filePath, 'utf8'));
}

function setConfig(config) {
  const updatedConfig = cloneDeep(config);
  if (!updatedConfig.test_configs) {
    updatedConfig.test_configs = {};
  }
  if (updatedConfig.deployment === 'default') {
    throw new Error('the default deployment cannot be used for integration tests');
  }
  updatedConfig.test_configs.buckets = updatedConfig.buckets;
  updatedConfig.test_configs.deployment = updatedConfig.deployment;
  updatedConfig.test_configs.cmr = updatedConfig.cmr;
  updatedConfig.test_configs.ems = updatedConfig.ems;

  return updatedConfig.test_configs;
}

function loadConfigFromKes(type) {
  // make sure deployment env variable is set
  if (!process.env.DEPLOYMENT) {
    throw new Error(
      'You MUST set DEPLOYMENT environment variable with the name' +
      ' of your deployment before running tests.'
    );
  }

  const params = {
    app: {
      deployment: process.env.DEPLOYMENT,
      configFile: './app/config.yml',
      kesFolder: './app'
    },
    iam: {
      deployment: process.env.DEPLOYMENT,
      configFile: './app/config.yml',
      kesFolder: './iam',
      stackName: '{{prefix}}}-iam'
    }
  };
  const config = new Config(params[type]);
  return setConfig(config);
}

const loadConfigYmlFile = (stackName) => {
  const ymlConfigs = loadYmlFile('./config.yml');
  const stackConfig = get(ymlConfigs, stackName, {});

  return {
    ...ymlConfigs.default,
    ...stackConfig,
    stackName
  };
};

const loadEnvFile = async (filename) => {
  try {
    const envConfig = dotenv.parse(await promisedReadFile(filename));

    Object.keys(envConfig).forEach((k) => {
      if (isNil(process.env[k])) process.env[k] = envConfig[k];
    });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
};

const verifyRequiredEnvironmentVariables = () => {
  [
    'DEPLOYMENT',
    'AWS_REGION',
    'AWS_ACCOUNT_ID',
    'EARTHDATA_CLIENT_ID',
    'EARTHDATA_CLIENT_PASSWORD',
    'EARTHDATA_PASSWORD',
    'EARTHDATA_USERNAME',
    'TOKEN_SECRET'
  ].forEach((x) => {
    if (isNil(process.env[x])) {
      throw new Error(`Environment variable "${x}" is not set.`);
    }
  });
};

const loadConfig = async (type = 'app') => {
  await loadEnvFile('./.env');
  verifyRequiredEnvironmentVariables();

  const configFromFile = process.env.KES_DEPLOYMENT === 'true' ?
    loadConfigFromKes(type) :
    loadConfigYmlFile(process.env.DEPLOYMENT);

  const bucketsObject = await getS3Object(
    configFromFile.bucket,
    `${configFromFile.stackName}/workflows/buckets.json`
  );
  const buckets = JSON.parse(bucketsObject.Body.toString());

  return {
    ...configFromFile,
    buckets
  };
};

/**
 * Creates a new file using a template file and configuration object which
 * defines fields to write to in the input template.
 *
 * @param   {Object} options - Options
 * @param   {string} options.inputTemplateFilename - File path and name of template file (json)
 * @param   {Object} options.config - Object to use to write to fields in the template
 * @returns {string} - File path and name of output file (json)
 */
function templateFile({ inputTemplateFilename, config }) {
  const inputTemplate = JSON.parse(fs.readFileSync(inputTemplateFilename, 'utf8'));
  const templatedInput = merge(cloneDeep(inputTemplate), config);
  let jsonString = JSON.stringify(templatedInput, null, 2);
  jsonString = jsonString.replace('{{AWS_ACCOUNT_ID}}', config.AWS_ACCOUNT_ID);
  const templatedInputFilename = inputTemplateFilename.replace('.template', '');
  fs.writeFileSync(templatedInputFilename, jsonString);
  return templatedInputFilename;
}

/**
 * Upload a file from the test-data package to the S3 test data
 * and update contents with replacements
 *
 * @param {string} file - filename of data to upload
 * @param {string} bucket - bucket to upload to
 * @param {string} prefix - S3 folder prefix
 * @param {Array<Object>} [replacements] - array of replacements in file content e.g. [{old: 'test', new: 'newTest' }]
 * @returns {Promise<Object>} - promise returned from S3 PUT
 */
function updateAndUploadTestFileToBucket(file, bucket, prefix = 'cumulus-test-data/pdrs', replacements = []) {
  let data;
  if (replacements.length > 0) {
    data = fs.readFileSync(require.resolve(file), 'utf8');
    replacements.forEach((replace) => {
      data = globalReplace(data, replace.old, replace.new);
    });
  } else data = fs.readFileSync(require.resolve(file));
  const key = path.basename(file);
  return s3().putObject({
    Bucket: bucket,
    Key: `${prefix}/${key}`,
    Body: data,
    ContentType: mime.lookup(key) || null
  }).promise();
}

/**
 * For the given bucket, upload all the test data files to S3
 * and update contents with replacements
 *
 * @param {string} bucket - S3 bucket
 * @param {Array<string>} data - list of test data files
 * @param {string} prefix - S3 folder prefix
 * @param {Array<Object>} [replacements] - array of replacements in file content e.g. [{old: 'test', new: 'newTest' }]
 * @returns {Array<Promise>} - responses from S3 upload
 */
function updateAndUploadTestDataToBucket(bucket, data, prefix, replacements) {
  return Promise.all(data.map((file) => updateAndUploadTestFileToBucket(file, bucket, prefix, replacements)));
}

/**
 * For the given bucket, upload all the test data files to S3
 *
 * @param {string} bucket - S3 bucket
 * @param {Array<string>} data - list of test data files
 * @param {string} prefix - S3 folder prefix
 * @returns {Array<Promise>} - responses from S3 upload
 */
function uploadTestDataToBucket(bucket, data, prefix) {
  return updateAndUploadTestDataToBucket(bucket, data, prefix);
}

/**
 * Delete a folder on a given bucket on S3
 *
 * @param {string} bucket - the bucket name
 * @param {string} folder - the folder to delete
 * @returns {Promise} undefined
 */
async function deleteFolder(bucket, folder) {
  const l = await s3().listObjectsV2({
    Bucket: bucket,
    Prefix: folder
  }).promise();

  await Promise.all(l.Contents.map((item) =>
    s3().deleteObject({
      Bucket: bucket,
      Key: item.Key
    }).promise()));
}

/**
 * Returns execution ARN from a statement machine Arn and executionName
 *
 * @param {string} executionArn - execution ARN
 * @returns {string} return aws console url for the execution
 */
function getExecutionUrl(executionArn) {
  const region = process.env.AWS_DEFAULT_REGION || 'us-east-1';
  return `https://console.aws.amazon.com/states/home?region=${region}` +
          `#/executions/details/${executionArn}`;
}

/**
 * Get URL to a public file in S3
 *
 * @param {Object} params
 * @param {string} params.bucket - S3 bucket
 * @param {string} params.key - S3 object key
 *
 * @returns {string} - Public S3 file URL
 */
function getPublicS3FileUrl({ bucket, key }) {
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

/**
 * Run kes command using stack configuration.
 *
 * @param {Object} config - configuration object from loadConfig()
 * @param {Object} [options] - configuration options with the following keys>
 * @param {string} [options.template=node_modules/@cumulus/deployment/app] - optional template command line kes option
 * @param {string} [options.kesClass] - optional kes-class command line kes option
 * @param {string} [options.kesCommand] - optional kes command to run, defaults to deploy
 * @param {integer} [options.timeout=30] - Timeout value in minutes
 * @returns {Promise<undefined>}
 */
async function runKes(config, options = {}) {
  const timeoutInMinutes = options.timeout || 30;

  const kesCommand = './node_modules/.bin/kes';
  const kesOptions = [
    'cf', options.kesCommand || 'deploy',
    '--kes-folder', options.kesFolder || 'app',
    '--template', options.template || 'node_modules/@cumulus/deployment/app',
    '--deployment', config.deployment,
    '--region', 'us-east-1'
  ];

  if (options.kesClass) kesOptions.push('--kes-class', options.kesClass);

  const kesProcess = execa(kesCommand, kesOptions);

  kesProcess.stdout.pipe(process.stdout);
  kesProcess.stderr.pipe(process.stderr);

  await pTimeout(
    kesProcess,
    timeoutInMinutes * MILLISECONDS_IN_A_MINUTE
  );
}

async function getFileMetadata(file) {
  let Bucket;
  let Key;
  if (file.bucket && file.filepath) {
    Bucket = file.bucket;
    Key = file.filepath;
  } else if (file.bucket && file.key) {
    Bucket = file.bucket;
    Key = file.key;
  } else if (file.filename) {
    const parsedUrl = parseS3Uri(file.filename);
    Bucket = parsedUrl.Bucket;
    Key = parsedUrl.Key;
  } else {
    throw new Error(`Unable to determine file location: ${JSON.stringify(file)}`);
  }

  try {
    const headObjectResponse = await headObject(Bucket, Key);
    return {
      filename: file.filename,
      size: headObjectResponse.ContentLength,
      LastModified: headObjectResponse.LastModified
    };
  } catch (err) {
    log.error(`Failed to headObject the object at ${Bucket}/${Key} in s3.`);
    throw (err);
  }
}

/**
 * Get file headers for a set of files.
 *
 * @param {Array<Object>} files - array of file objects
 * @returns {Promise<Array>} - file detail responses
 */
function getFilesMetadata(files) {
  return Promise.all(files.map(getFileMetadata));
}

/**
 * Creates a backup of a file, executes the specified function, and makes sure
 * that the file is restored from backup.
 *
 * @param {string} file - the file to backup
 * @param {Function} fn - the function to execute
 */
async function protectFile(file, fn) {
  const backupLocation = tempy.file();
  await promisedCopyFile(file, backupLocation);

  try {
    return await Promise.resolve().then(fn);
  } finally {
    await promisedCopyFile(backupLocation, file);
    await promisedUnlink(backupLocation);
  }
}

const isLambdaStatusLogEntry = (logEntry) =>
  logEntry.message.includes('START') ||
  logEntry.message.includes('END') ||
  logEntry.message.includes('REPORT');

const isCumulusLogEntry = (logEntry) => !isLambdaStatusLogEntry(logEntry);

module.exports = {
  createTestDataPath,
  createTestSuffix,
  createTimestampedTestId,
  deleteFolder,
  getExecutionUrl,
  getFilesMetadata,
  getPublicS3FileUrl,
  isCumulusLogEntry,
  loadConfig,
  loadYmlFile,
  protectFile,
  runKes,
  templateFile,
  timestampedName,
  updateAndUploadTestDataToBucket,
  uploadTestDataToBucket
};
