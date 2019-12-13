'use strict';

const fs = require('fs');
const { URL } = require('url');
const got = require('got');

const { models: { AccessToken } } = require('@cumulus/api');
const { BucketsConfig } = require('@cumulus/common');
const { generateChecksumFromStream } = require('@cumulus/checksum');
const {
  distributionApi: {
    getDistributionApiRedirect
  },
  EarthdataLogin: { getEarthdataAccessToken }
} = require('@cumulus/integration-tests');

const {
  loadConfig,
  createTestDataPath,
  createTimestampedTestId,
  uploadTestDataToBucket,
  deleteFolder
} = require('../../helpers/testUtils');
const { setDistributionApiEnvVars } = require('../../helpers/apiUtils');

const s3Data = ['@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met'];

/**
 * Login with Earthdata and get response for redirect back to
 * distribution API.
 */
async function getTestAccessToken() {
  const accessTokenResponse = await getEarthdataAccessToken({
    redirectUri: process.env.DISTRIBUTION_REDIRECT_ENDPOINT,
    requestOrigin: process.env.DISTRIBUTION_ENDPOINT
  });
  return accessTokenResponse.accessToken;
}

// TODO Update these tests to use TEA
xdescribe('Distribution API', () => {
  let fileKey;
  let privateBucketName;
  let protectedBucketName;
  let publicBucketName;
  let testDataFolder;

  beforeAll(async () => {
    const config = await loadConfig();

    const bucketsConfig = new BucketsConfig(config.buckets);
    protectedBucketName = bucketsConfig.protectedBuckets()[0].name;
    privateBucketName = bucketsConfig.privateBuckets()[0].name;
    publicBucketName = bucketsConfig.publicBuckets()[0].name;
    process.env.stackName = config.stackName;

    const testId = createTimestampedTestId(config.stackName, 'DistributionAPITest');
    testDataFolder = createTestDataPath(testId);
    console.log(`Distribution API tests running in ${testDataFolder}`);
    fileKey = `${testDataFolder}/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met`;

    process.env.AccessTokensTable = `${config.stackName}-AccessTokensTable`;

    await Promise.all([
      uploadTestDataToBucket(protectedBucketName, s3Data, testDataFolder),
      uploadTestDataToBucket(privateBucketName, s3Data, testDataFolder),
      uploadTestDataToBucket(publicBucketName, s3Data, testDataFolder)
    ]);
    setDistributionApiEnvVars();
  });

  afterAll(async () => {
    await Promise.all([
      deleteFolder(protectedBucketName, testDataFolder),
      deleteFolder(privateBucketName, testDataFolder),
      deleteFolder(publicBucketName, testDataFolder)
    ]);
  });

  describe('handles requests for files over HTTPS', () => {
    let fileChecksum;
    let protectedFilePath;
    let privateFilePath;
    let publicFilePath;
    let accessToken;

    beforeAll(async () => {
      accessToken = await getTestAccessToken();
      fileChecksum = await generateChecksumFromStream(
        'cksum',
        fs.createReadStream(require.resolve(s3Data[0]))
      );
      publicFilePath = `/${publicBucketName}/${fileKey}`;
      protectedFilePath = `/${protectedBucketName}/${fileKey}`;
      privateFilePath = `/${privateBucketName}/${fileKey}`;
    });

    afterAll(async () => {
      const accessTokensModel = new AccessToken();
      await accessTokensModel.delete({ accessToken });
    });

    describe('an unauthorized user', () => {
      it('redirects to Earthdata login for unauthorized requests for protected files', async () => {
        const response = await getDistributionApiRedirect(protectedFilePath);
        const authorizeUrl = new URL(response);
        expect(authorizeUrl.origin).toEqual(process.env.EARTHDATA_BASE_URL);
        expect(authorizeUrl.searchParams.get('state')).toEqual(`/${protectedBucketName}/${fileKey}`);
        expect(authorizeUrl.pathname).toEqual('/oauth/authorize');
      });

      it('downloads a public science file', async () => {
        const s3SignedUrl = await getDistributionApiRedirect(publicFilePath);
        const parts = new URL(s3SignedUrl);
        const userName = parts.searchParams.get('x-EarthdataLoginUsername');

        const fileStream = got.stream(s3SignedUrl);
        const downloadChecksum = await generateChecksumFromStream('cksum', fileStream);
        expect(userName).toEqual('unauthenticated user');
        expect(downloadChecksum).toEqual(fileChecksum);
      });
    });

    describe('an authorized user', () => {
      it('downloads the protected science file for authorized requests', async () => {
        const s3SignedUrl = await getDistributionApiRedirect(protectedFilePath, accessToken);
        const fileStream = got.stream(s3SignedUrl);
        const downloadChecksum = await generateChecksumFromStream('cksum', fileStream);
        expect(downloadChecksum).toEqual(fileChecksum);
      });

      it('downloads a public science file', async () => {
        const s3SignedUrl = await getDistributionApiRedirect(publicFilePath, accessToken);
        const parts = new URL(s3SignedUrl);
        const userName = parts.searchParams.get('x-EarthdataLoginUsername');

        const fileStream = got.stream(s3SignedUrl);
        const downloadChecksum = await generateChecksumFromStream('cksum', fileStream);
        expect(userName).toEqual('unauthenticated user');
        expect(downloadChecksum).toEqual(fileChecksum);
      });

      it('refuses downloads of files in private buckets as forbidden', async () => {
        const signedUrl = await getDistributionApiRedirect(privateFilePath, accessToken);
        try {
          await got(signedUrl);
          fail('Expected an error to be thrown');
        } catch (error) {
          expect(error.statusCode).toEqual(403);
          expect(error.message).toMatch(/Forbidden/);
        }
      });
    });
  });
});
